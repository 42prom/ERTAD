-- Channel-local writing restrictions; membership and task authority remain canonical.
CREATE TABLE ertad.channel_restrictions (
 organization_id uuid NOT NULL,channel_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),message_id uuid NOT NULL,
 subject_id uuid NOT NULL REFERENCES ertad.member_users(id),issuer_id uuid NOT NULL REFERENCES ertad.member_users(id),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 10 AND 1000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 appeal text CHECK(length(trim(appeal)) BETWEEN 10 AND 1000),appealed_at timestamptz,
 outcome text CHECK(outcome IN ('uphold','lift')),review_reason text CHECK(length(trim(review_reason)) BETWEEN 10 AND 1000),
 reviewer_id uuid REFERENCES ertad.member_users(id),reviewed_at timestamptz,version integer NOT NULL DEFAULT 1,
 PRIMARY KEY(organization_id,id),FOREIGN KEY(organization_id,channel_id,message_id) REFERENCES ertad.channel_messages(organization_id,channel_id,id),
 CHECK(subject_id<>issuer_id AND expires_at>created_at AND expires_at<=created_at+interval '30 days'),
 CHECK((version=1 AND appeal IS NULL AND appealed_at IS NULL AND outcome IS NULL AND reviewer_id IS NULL AND reviewed_at IS NULL AND review_reason IS NULL)
 OR(version=2 AND appeal IS NOT NULL AND appealed_at IS NOT NULL AND outcome IS NULL AND reviewer_id IS NULL AND reviewed_at IS NULL AND review_reason IS NULL)
 OR(version=3 AND appeal IS NOT NULL AND appealed_at IS NOT NULL AND outcome IS NOT NULL AND reviewer_id IS NOT NULL AND reviewer_id NOT IN(subject_id,issuer_id) AND reviewed_at IS NOT NULL AND review_reason IS NOT NULL))
);
CREATE INDEX channel_restriction_subject ON ertad.channel_restrictions(organization_id,channel_id,subject_id,expires_at);
CREATE INDEX channel_restriction_appeals ON ertad.channel_restrictions(organization_id,created_at,id) WHERE version=2;
CREATE FUNCTION ertad.freeze_channel_restriction() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP<>'UPDATE' OR (to_jsonb(NEW)-ARRAY['appeal','appealed_at','outcome','review_reason','reviewer_id','reviewed_at','version'])
 IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['appeal','appealed_at','outcome','review_reason','reviewer_id','reviewed_at','version'])
 OR NEW.version<>OLD.version+1 OR OLD.version NOT IN(1,2)
 OR (OLD.version=2 AND (NEW.appeal,NEW.appealed_at) IS DISTINCT FROM(OLD.appeal,OLD.appealed_at)) THEN
 RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Restriction history is immutable'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER freeze_channel_restriction BEFORE UPDATE OR DELETE ON ertad.channel_restrictions FOR EACH ROW EXECUTE FUNCTION ertad.freeze_channel_restriction();
CREATE FUNCTION ertad.channel_restricted(actor uuid,c ertad.channels) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM ertad.channel_restrictions r WHERE r.organization_id=c.organization_id AND r.channel_id=c.id AND r.subject_id=actor
 AND r.expires_at>clock_timestamp() AND r.outcome IS DISTINCT FROM 'lift')
$$;
ALTER FUNCTION ertad.channel_allowed(uuid,ertad.channels,text) RENAME TO channel_scope_allowed;
CREATE FUNCTION ertad.channel_allowed(actor uuid,c ertad.channels,permission text DEFAULT 'channel.read') RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT ertad.channel_scope_allowed(actor,c,permission) AND (permission<>'channel.post' OR NOT ertad.channel_restricted(actor,c))
$$;
CREATE FUNCTION ertad.channel_restriction_reviewer(actor uuid,c ertad.channels,r ertad.channel_restrictions) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT ertad.channel_allowed(actor,c,'channel.moderate') AND actor NOT IN(r.subject_id,r.issuer_id)
 AND NOT EXISTS(SELECT 1 FROM ertad.channel_reports p WHERE p.organization_id=r.organization_id AND p.channel_id=r.channel_id AND p.message_id=r.message_id AND p.reporter_id=actor)
$$;
CREATE FUNCTION ertad.channel_restriction_view(actor uuid,c ertad.channels,r ertad.channel_restrictions) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',r.id,'channelId',c.id,'channelTitle',COALESCE(w.title,c.title),
 'participantTag',(SELECT min(seq) FROM ertad.channel_messages WHERE organization_id=c.organization_id AND channel_id=c.id AND author_id=r.subject_id),
 'mine',actor=r.subject_id,'reason',r.reason,'createdAt',r.created_at,'expiresAt',r.expires_at,'appeal',r.appeal,'appealedAt',r.appealed_at,
 'outcome',r.outcome,'reviewReason',r.review_reason,'reviewedAt',r.reviewed_at,'version',r.version,
 'active',r.expires_at>clock_timestamp() AND r.outcome IS DISTINCT FROM 'lift',
 'canAppeal',actor=r.subject_id AND r.version=1,'canReview',r.version=2 AND ertad.channel_restriction_reviewer(actor,c,r))
 FROM (SELECT 1) x LEFT JOIN ertad.work_items w ON w.organization_id=c.organization_id AND w.id=c.work_id
$$;
CREATE OR REPLACE FUNCTION ertad.channel_view(actor uuid,c ertad.channels) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT ertad.channel_base_view(actor,c)||jsonb_build_object('workId',c.work_id,'workStatus',w.status,
 'title',COALESCE(w.title,c.title),'archived',c.archived OR COALESCE(w.status<>'open',false),
 'postingRestriction',(SELECT jsonb_build_object('id',r.id,'expiresAt',r.expires_at,'reason',r.reason) FROM ertad.channel_restrictions r
 WHERE r.organization_id=c.organization_id AND r.channel_id=c.id AND r.subject_id=actor AND r.expires_at>clock_timestamp() AND r.outcome IS DISTINCT FROM 'lift' ORDER BY r.created_at DESC LIMIT 1))
 FROM (SELECT 1) x LEFT JOIN ertad.work_items w ON w.organization_id=c.organization_id AND w.id=c.work_id
$$;
ALTER FUNCTION ertad.channel_command(uuid,text,text,uuid,jsonb,text) RENAME TO channel_content_command;
REVOKE ALL ON FUNCTION ertad.channel_content_command(uuid,text,text,uuid,jsonb,text) FROM PUBLIC,ertad_app;
CREATE FUNCTION ertad.channel_command(sid uuid,token text,op text,org uuid,input jsonb,fingerprint text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid;c ertad.channels;m ertad.channel_messages;r ertad.channel_restrictions;receipt ertad.channel_receipts;result jsonb;
 writing boolean;page integer;until_time timestamptz;newid uuid;
BEGIN
 IF op NOT IN('restrictions','restrict','appeal','review-appeal') THEN
  result:=ertad.channel_content_command(sid,token,op,org,input,fingerprint);
  IF op='thread' THEN
   actor:=ertad.review_identity(sid,token,false);
   SELECT * INTO c FROM ertad.channels WHERE organization_id=org AND id=(input->>'id')::uuid;
   result:=jsonb_set(result,'{data,items}',(SELECT COALESCE(jsonb_agg(item||jsonb_build_object('canRestrict',
    ertad.channel_allowed(actor,c,'channel.moderate') AND NOT c.archived AND NOT msg.removed AND msg.author_id<>actor
    AND (c.work_id IS NULL OR EXISTS(SELECT 1 FROM ertad.work_items w WHERE w.organization_id=org AND w.id=c.work_id AND w.status='open'))
    AND NOT ertad.channel_restricted(msg.author_id,c) AND NOT EXISTS(SELECT 1 FROM ertad.channel_reports p WHERE p.organization_id=org AND p.channel_id=c.id AND p.message_id=msg.id AND p.reporter_id=actor)) ORDER BY msg.seq),'[]')
    FROM jsonb_array_elements(result->'data'->'items') item JOIN ertad.channel_messages msg ON msg.organization_id=org AND msg.channel_id=c.id AND msg.id=(item->>'id')::uuid));
  END IF;
  RETURN result;
 END IF;
 writing:=op<>'restrictions';actor:=ertad.review_identity(sid,token,op IN('restrict','review-appeal'));
 IF writing THEN PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR UPDATE;
 ELSE PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR SHARE;END IF;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint);
 PERFORM ertad.review_identity(sid,token,op IN('restrict','review-appeal'));
 IF NOT EXISTS(SELECT 1 FROM ertad.units u WHERE u.organization_id=org AND ertad.review_has_scope(actor,org,u.id,'channel.read')) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Channels unavailable';END IF;
 IF op='restrictions' THEN
  page:=COALESCE((input->>'page')::int,1);
  IF page NOT BETWEEN 1 AND 1000 OR COALESCE(input->>'view','pending') NOT IN('pending','mine','history') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid restriction view';END IF;
  WITH visible AS MATERIALIZED(SELECT ertad.channel_restriction_view(actor,ch,x) v FROM ertad.channel_restrictions x JOIN ertad.channels ch ON ch.organization_id=x.organization_id AND ch.id=x.channel_id
   WHERE x.organization_id=org AND ertad.channel_allowed(actor,ch) AND (x.subject_id=actor OR ertad.channel_allowed(actor,ch,'channel.moderate'))),
  filtered AS(SELECT v FROM visible WHERE CASE COALESCE(input->>'view','pending') WHEN 'pending' THEN (v->>'canReview')::boolean WHEN 'mine' THEN (v->>'mine')::boolean ELSE true END),
  paged AS(SELECT v FROM filtered ORDER BY v->>'createdAt' DESC,v->>'id' LIMIT 25 OFFSET(page-1)*25)
  SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(v ORDER BY v->>'createdAt' DESC,v->>'id') FROM paged),'[]'),'total',(SELECT count(*) FROM filtered),'page',page) INTO result;
 ELSE
  SELECT * INTO c FROM ertad.channels WHERE organization_id=org AND id=(input->>'id')::uuid;
  IF NOT FOUND OR NOT ertad.channel_allowed(actor,c) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Channel unavailable';END IF;
  IF op='restrict' THEN
   SELECT * INTO m FROM ertad.channel_messages WHERE organization_id=org AND channel_id=c.id AND id=(input->>'messageId')::uuid;
   IF NOT FOUND OR m.author_id=actor OR NOT ertad.channel_allowed(actor,c,'channel.moderate')
    OR EXISTS(SELECT 1 FROM ertad.channel_reports p WHERE p.organization_id=org AND p.channel_id=c.id AND p.message_id=m.id AND p.reporter_id=actor)
    THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Independent moderator required';END IF;
  ELSE
   SELECT * INTO r FROM ertad.channel_restrictions WHERE organization_id=org AND channel_id=c.id AND id=(input->>'restrictionId')::uuid;
   IF NOT FOUND OR (op='appeal' AND r.subject_id<>actor) OR (op='review-appeal' AND NOT ertad.channel_restriction_reviewer(actor,c,r)) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Restriction action unavailable';END IF;
  END IF;
  IF fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' OR input->>'key' IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Request identity required';END IF;
  SELECT * INTO receipt FROM ertad.channel_receipts WHERE organization_id=org AND actor_id=actor AND key=(input->>'key')::uuid;
  IF FOUND THEN
   IF receipt.fingerprint<>fingerprint THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Retry conflict';END IF;
   RETURN jsonb_build_object('data',receipt.response,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'changed',false));
  END IF;
  IF op='restrict' THEN
   until_time:=(input->>'expiresAt')::timestamptz;
   IF until_time IS NULL OR until_time<=clock_timestamp() OR until_time>clock_timestamp()+interval '30 days' OR length(trim(COALESCE(input->>'reason',''))) NOT BETWEEN 10 AND 1000 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Bounded duration and reason required';END IF;
   IF c.archived OR m.removed OR (c.work_id IS NOT NULL AND EXISTS(SELECT 1 FROM ertad.work_items w WHERE w.organization_id=org AND w.id=c.work_id AND w.status<>'open')) OR ertad.channel_restricted(m.author_id,c) THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Restriction unavailable';END IF;
   INSERT INTO ertad.channel_restrictions(organization_id,channel_id,message_id,subject_id,issuer_id,reason,expires_at)
   VALUES(org,c.id,m.id,m.author_id,actor,trim(input->>'reason'),until_time) RETURNING id INTO newid;
  ELSE
   IF r.version IS DISTINCT FROM (input->>'version')::int THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Restriction changed';END IF;
   IF length(trim(COALESCE(input->>'reason',''))) NOT BETWEEN 10 AND 1000 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Reason required';END IF;
   IF op='appeal' THEN
    IF r.version<>1 THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Appeal already recorded';END IF;
    UPDATE ertad.channel_restrictions SET appeal=trim(input->>'reason'),appealed_at=clock_timestamp(),version=2 WHERE organization_id=org AND id=r.id;
   ELSE
    IF r.version<>2 THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Pending appeal required';END IF;
    IF input->>'outcome' IS NULL OR input->>'outcome' NOT IN('uphold','lift') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid outcome';END IF;
    UPDATE ertad.channel_restrictions SET outcome=input->>'outcome',review_reason=trim(input->>'reason'),reviewer_id=actor,reviewed_at=clock_timestamp(),version=3 WHERE organization_id=org AND id=r.id;
   END IF;
   newid:=r.id;
  END IF;
  result:=jsonb_build_object('id',c.id,'restrictionId',newid);
  INSERT INTO ertad.channel_receipts VALUES(org,actor,(input->>'key')::uuid,fingerprint,result);
 END IF;
 RETURN jsonb_build_object('data',result,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'channelId',c.id,'restrictionId',newid,'operation',op,'changed',writing));
END $$;
REVOKE ALL ON ertad.channel_restrictions FROM PUBLIC,ertad_app;
REVOKE ALL ON FUNCTION ertad.freeze_channel_restriction(),ertad.channel_restricted(uuid,ertad.channels),ertad.channel_allowed(uuid,ertad.channels,text),
 ertad.channel_restriction_reviewer(uuid,ertad.channels,ertad.channel_restrictions),ertad.channel_restriction_view(uuid,ertad.channels,ertad.channel_restrictions),ertad.channel_command(uuid,text,text,uuid,jsonb,text) FROM PUBLIC,ertad_app;
GRANT EXECUTE ON FUNCTION ertad.channel_command(uuid,text,text,uuid,jsonb,text) TO ertad_app;
