-- Moderation notices project canonical restrictions; no private message/reason text is copied.
CREATE TABLE ertad.moderation_inbox_reads (
 organization_id uuid NOT NULL,restriction_id uuid NOT NULL,recipient_id uuid NOT NULL REFERENCES ertad.member_users(id),
 read_version integer NOT NULL CHECK(read_version BETWEEN 1 AND 6),
 PRIMARY KEY(organization_id,restriction_id,recipient_id),
 FOREIGN KEY(organization_id,restriction_id) REFERENCES ertad.channel_restrictions(organization_id,id)
);
ALTER FUNCTION ertad.inbox_entries(uuid,uuid) RENAME TO inbox_prior_moderation_entries;
ALTER FUNCTION ertad.inbox_contexts(uuid) RENAME TO inbox_prior_moderation_contexts;
CREATE FUNCTION ertad.inbox_entries(actor uuid,org uuid) RETURNS TABLE(
 source text,id uuid,version integer,unit_id uuid,title text,status text,updated_at timestamptz,deadline timestamptz,unread boolean,action text
) LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT * FROM ertad.inbox_prior_moderation_entries(actor,org)
 UNION ALL
 SELECT 'moderation',r.id,n.version,c.unit_id,'channel_restriction',
  CASE WHEN r.outcome='lift' THEN 'lifted' WHEN r.version=2 THEN 'appealed'
       WHEN r.expires_at<=clock_timestamp() THEN 'expired' WHEN r.outcome='uphold' THEN 'upheld' ELSE 'restricted' END,
  greatest(r.created_at,r.appealed_at,r.reviewed_at,
   CASE WHEN r.expires_at<=clock_timestamp() AND r.outcome IS DISTINCT FROM 'lift' THEN r.expires_at END),r.expires_at,
  COALESCE(rd.read_version,0)<n.version,
  CASE WHEN r.version=2 AND ertad.channel_restriction_reviewer(actor,c,r) THEN 'review_appeal' ELSE '' END
 FROM ertad.channel_restrictions r JOIN ertad.channels c ON c.organization_id=r.organization_id AND c.id=r.channel_id
 CROSS JOIN LATERAL(SELECT r.version*2-1 + CASE WHEN r.expires_at<=clock_timestamp() AND r.outcome IS DISTINCT FROM 'lift' THEN 1 ELSE 0 END version) n
 LEFT JOIN ertad.moderation_inbox_reads rd ON rd.organization_id=org AND rd.restriction_id=r.id AND rd.recipient_id=actor
 WHERE r.organization_id=org AND ertad.channel_allowed(actor,c)
  AND (actor=r.subject_id OR (ertad.channel_allowed(actor,c,'channel.moderate') AND
    (actor=r.issuer_id OR (r.version>=2 AND ertad.channel_restriction_reviewer(actor,c,r)))))
$$;
CREATE FUNCTION ertad.inbox_contexts(actor uuid) RETURNS TABLE(id uuid,name text)
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT * FROM ertad.inbox_prior_moderation_contexts(actor)
 UNION
 SELECT o.id,o.name FROM ertad.organizations o WHERE o.status='active' AND EXISTS(
  SELECT 1 FROM ertad.units u WHERE u.organization_id=o.id AND ertad.review_has_scope(actor,o.id,u.id,'channel.read'))
$$;
REVOKE ALL ON ertad.moderation_inbox_reads FROM PUBLIC,ertad_app;
REVOKE ALL ON FUNCTION ertad.inbox_entries(uuid,uuid),ertad.inbox_contexts(uuid) FROM PUBLIC,ertad_app;

-- Exact-record navigation uses current domain authority, never the notice as a grant.
ALTER FUNCTION ertad.channel_command(uuid,text,text,uuid,jsonb,text) RENAME TO channel_moderation_command;
REVOKE ALL ON FUNCTION ertad.channel_moderation_command(uuid,text,text,uuid,jsonb,text) FROM PUBLIC,ertad_app;
CREATE FUNCTION ertad.channel_command(sid uuid,token text,op text,org uuid,input jsonb,fingerprint text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid;c ertad.channels;r ertad.channel_restrictions;
BEGIN
 IF op<>'restriction' THEN RETURN ertad.channel_moderation_command(sid,token,op,org,input,fingerprint); END IF;
 actor:=ertad.review_identity(sid,token,false);
 PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR SHARE;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint);
 PERFORM ertad.review_identity(sid,token,false);
 SELECT * INTO r FROM ertad.channel_restrictions WHERE organization_id=org AND id=(input->>'restrictionId')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Restriction unavailable';END IF;
 SELECT * INTO c FROM ertad.channels WHERE organization_id=org AND id=r.channel_id;
 IF NOT ertad.channel_allowed(actor,c) OR (actor<>r.subject_id AND NOT ertad.channel_allowed(actor,c,'channel.moderate')) THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Restriction unavailable';END IF;
 RETURN jsonb_build_object('data',ertad.channel_restriction_view(actor,c,r),'audit',jsonb_build_object('actorId',actor,'organizationId',org,'restrictionId',r.id,'operation',op,'changed',false));
END $$;
REVOKE ALL ON FUNCTION ertad.channel_command(uuid,text,text,uuid,jsonb,text) FROM PUBLIC,ertad_app;
GRANT EXECUTE ON FUNCTION ertad.channel_command(uuid,text,text,uuid,jsonb,text) TO ertad_app;

CREATE OR REPLACE FUNCTION ertad.inbox_command(sid uuid,token text,op text,org uuid,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid; result jsonb; item record; requested integer; page integer; view_name text; source_name text;
BEGIN
 IF op NOT IN ('summary','list','read') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid inbox operation'; END IF;
 actor:=ertad.review_identity(sid,token,false);
 IF op='summary' THEN
  PERFORM 1 FROM ertad.organizations o WHERE EXISTS(SELECT 1 FROM ertad.memberships m WHERE m.organization_id=o.id AND m.user_id=actor) ORDER BY o.id FOR SHARE;
 ELSIF op='read' THEN PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR UPDATE;
 ELSE PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR SHARE; END IF;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint); PERFORM ertad.review_identity(sid,token,false);
 IF op<>'summary' AND NOT EXISTS(SELECT 1 FROM ertad.inbox_contexts(actor) c WHERE c.id=org) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Inbox unavailable'; END IF;
 IF op='summary' THEN
  WITH contexts AS MATERIALIZED(SELECT * FROM ertad.inbox_contexts(actor)), entries AS MATERIALIZED(SELECT e.* FROM contexts c CROSS JOIN LATERAL ertad.inbox_entries(actor,c.id) e)
  SELECT jsonb_build_object('contexts',COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.name,c.id) FROM contexts c),'[]'),
   'unread',(SELECT count(*) FROM entries WHERE unread),'actionRequired',(SELECT count(*) FROM entries WHERE action<>'')) INTO result;
 ELSIF op='list' THEN
  page:=COALESCE((input->>'page')::int,1);view_name:=COALESCE(input->>'view','action');source_name:=COALESCE(input->>'source','all');
  IF page NOT BETWEEN 1 AND 1000 OR view_name NOT IN ('all','unread','action') OR source_name NOT IN ('all','membership','unit','work','collective','decision','moderation') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid inbox filter'; END IF;
  WITH visible AS MATERIALIZED(SELECT * FROM ertad.inbox_entries(actor,org) e WHERE (source_name='all' OR e.source=source_name)),
  filtered AS(SELECT * FROM visible WHERE CASE view_name WHEN 'unread' THEN unread WHEN 'action' THEN action<>'' ELSE true END),
  paged AS(SELECT * FROM filtered ORDER BY updated_at DESC,source,id LIMIT 25 OFFSET (page-1)*25)
  SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(jsonb_build_object('source',p.source,'id',p.id,'version',p.version,'unitId',p.unit_id,
   'unitName',CASE WHEN ertad.review_has_scope(actor,org,p.unit_id,'unit.read') THEN (SELECT name FROM ertad.units WHERE organization_id=org AND id=p.unit_id) END,
   'title',p.title,'status',p.status,'updatedAt',p.updated_at,'deadline',p.deadline,'unread',p.unread,'action',p.action) ORDER BY p.updated_at DESC,p.source,p.id) FROM paged p),'[]'),
   'total',(SELECT count(*) FROM filtered),'unread',(SELECT count(*) FROM visible WHERE unread),'actionRequired',(SELECT count(*) FROM visible WHERE action<>''),'page',page,'pageSize',25) INTO result;
 ELSE
  SELECT * INTO item FROM ertad.inbox_entries(actor,org) e WHERE e.source=input->>'source' AND e.id=(input->>'id')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Inbox item unavailable'; END IF;
  requested:=(input->>'version')::int;
  IF requested IS NULL OR requested<1 OR requested>item.version THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Observed version required'; END IF;
  IF item.source='membership' THEN
   INSERT INTO ertad.membership_inbox_reads VALUES(org,item.id,actor,requested) ON CONFLICT(organization_id,review_id,recipient_id) DO UPDATE SET read_version=greatest(membership_inbox_reads.read_version,excluded.read_version);
   IF requested>=item.version THEN UPDATE ertad.review_notifications SET read_at=COALESCE(read_at,clock_timestamp()) WHERE organization_id=org AND review_id=item.id AND recipient_id=actor; END IF;
  ELSIF item.source='unit' THEN
   INSERT INTO ertad.unit_inbox_reads VALUES(org,item.id,actor,requested) ON CONFLICT(organization_id,review_id,recipient_id) DO UPDATE SET read_version=greatest(unit_inbox_reads.read_version,excluded.read_version);
  ELSIF item.source='work' THEN UPDATE ertad.work_notifications SET read_at=COALESCE(read_at,clock_timestamp()) WHERE organization_id=org AND work_id=item.id AND recipient_id=actor AND version<=requested;
  ELSIF item.source='moderation' THEN
   INSERT INTO ertad.moderation_inbox_reads VALUES(org,item.id,actor,requested) ON CONFLICT(organization_id,restriction_id,recipient_id) DO UPDATE SET read_version=greatest(moderation_inbox_reads.read_version,excluded.read_version);
  ELSIF item.source='decision' THEN
   INSERT INTO ertad.decision_inbox_reads VALUES(org,item.id,actor,requested) ON CONFLICT(organization_id,decision_id,recipient_id) DO UPDATE SET read_version=greatest(decision_inbox_reads.read_version,excluded.read_version);
  ELSE UPDATE ertad.collective_notifications SET read_version=greatest(read_version,requested) WHERE organization_id=org AND proposal_id=item.id AND recipient_id=actor; END IF;
  result:=jsonb_build_object('id',item.id,'version',requested);
 END IF;
 RETURN jsonb_build_object('data',result,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'source',input->>'source','recordId',input->>'id'));
END $$;
