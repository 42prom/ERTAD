-- One existing conversation engine, one immutable task association per channel.
ALTER TABLE ertad.channels ADD COLUMN work_id uuid;
ALTER TABLE ertad.channels ADD CONSTRAINT channel_work_fk FOREIGN KEY(organization_id,work_id) REFERENCES ertad.work_items(organization_id,id);
CREATE UNIQUE INDEX channel_work_unique ON ertad.channels(organization_id,work_id) WHERE work_id IS NOT NULL;

CREATE FUNCTION ertad.work_channel_allowed(actor uuid,w ertad.work_items,permission text DEFAULT 'channel.read') RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT ertad.work_contributor(actor,w)
 AND ertad.review_has_scope(actor,w.organization_id,w.unit_id,'channel.read')
 AND ertad.review_has_scope(actor,w.organization_id,w.unit_id,permission)
 AND CASE permission WHEN 'channel.post' THEN w.status='open'
  WHEN 'channel.manage' THEN w.status='open' AND ertad.work_manager(actor,w) ELSE true END
$$;
CREATE OR REPLACE FUNCTION ertad.channel_allowed(actor uuid,c ertad.channels,permission text DEFAULT 'channel.read') RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT c.scope_path=ertad.unit_path(c.organization_id,c.unit_id)
 AND CASE WHEN c.work_id IS NULL THEN
  ertad.review_has_scope(actor,c.organization_id,c.unit_id,'channel.read')
  AND ertad.review_has_scope(actor,c.organization_id,c.unit_id,permission)
 ELSE EXISTS(SELECT 1 FROM ertad.work_items w WHERE w.organization_id=c.organization_id AND w.id=c.work_id
  AND w.unit_id=c.unit_id AND ertad.work_channel_allowed(actor,w,permission)) END
$$;
ALTER FUNCTION ertad.channel_view(uuid,ertad.channels) RENAME TO channel_base_view;
CREATE FUNCTION ertad.channel_view(actor uuid,c ertad.channels) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT ertad.channel_base_view(actor,c)||jsonb_build_object('workId',c.work_id,'workStatus',w.status,
  'title',COALESCE(w.title,c.title),'archived',c.archived OR COALESCE(w.status<>'open',false))
 FROM (SELECT 1) x LEFT JOIN ertad.work_items w ON w.organization_id=c.organization_id AND w.id=c.work_id
$$;
CREATE FUNCTION ertad.freeze_work_channel_link() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF (NEW.organization_id,NEW.work_id,NEW.unit_id,NEW.scope_path) IS DISTINCT FROM (OLD.organization_id,OLD.work_id,OLD.unit_id,OLD.scope_path) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Channel association is immutable';
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER freeze_work_channel_link BEFORE UPDATE ON ertad.channels FOR EACH ROW EXECUTE FUNCTION ertad.freeze_work_channel_link();
REVOKE ALL ON FUNCTION ertad.work_channel_allowed(uuid,ertad.work_items,text),ertad.channel_view(uuid,ertad.channels),ertad.freeze_work_channel_link() FROM PUBLIC,ertad_app;

CREATE OR REPLACE FUNCTION ertad.channel_command(sid uuid,token text,op text,org uuid,input jsonb,fingerprint text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid;w ertad.work_items;c ertad.channels;m ertad.channel_messages;r ertad.channel_reports;receipt ertad.channel_receipts;
 result jsonb;newid uuid;target uuid;permission text;writing boolean;page integer;before_seq integer;observed integer;
BEGIN
 IF op NOT IN ('work','work-create','contexts','units','list','thread','create','post','read','mute','archive','remove','report','reports','resolve') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid channel operation'; END IF;
 writing:=op IN ('work-create','create','post','read','mute','archive','remove','report','resolve');
 actor:=ertad.review_identity(sid,token,op IN ('work-create','create','archive','resolve'));
 IF op='contexts' THEN
  PERFORM 1 FROM ertad.organizations o WHERE EXISTS(SELECT 1 FROM ertad.memberships ms WHERE ms.organization_id=o.id AND ms.user_id=actor) ORDER BY o.id FOR SHARE;
 ELSIF writing THEN PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR UPDATE;
 ELSE PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR SHARE; END IF;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint);
 PERFORM ertad.review_identity(sid,token,op IN ('work-create','create','archive','resolve'));
 IF op='contexts' THEN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',o.id,'name',o.name) ORDER BY o.name,o.id),'[]') INTO result FROM ertad.organizations o WHERE o.status='active' AND EXISTS(
   SELECT 1 FROM ertad.units u WHERE u.organization_id=o.id AND ertad.review_has_scope(actor,o.id,u.id,'channel.read'));
 ELSE
  IF NOT EXISTS(SELECT 1 FROM ertad.units u WHERE u.organization_id=org AND ertad.review_has_scope(actor,org,u.id,'channel.read')) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Channels unavailable'; END IF;
  page:=COALESCE((input->>'page')::int,1);before_seq:=COALESCE((input->>'before')::int,0);
  IF page NOT BETWEEN 1 AND 1000 OR before_seq<0 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid pagination'; END IF;
  IF op IN ('work','work-create') THEN
   SELECT * INTO w FROM ertad.work_items WHERE organization_id=org AND id=(input->>'workId')::uuid;
   IF NOT FOUND OR NOT ertad.work_channel_allowed(actor,w) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Task conversation unavailable'; END IF;
   IF op='work-create' AND NOT ertad.work_channel_allowed(actor,w,'channel.manage') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Task conversation creation unavailable'; END IF;
   target:=w.unit_id;
  ELSIF op='create' THEN
   target:=(input->>'unitId')::uuid;
   IF NOT ertad.review_has_scope(actor,org,target,'channel.manage') OR NOT ertad.review_has_scope(actor,org,target,'channel.read') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Channel creation unavailable'; END IF;
  ELSIF op NOT IN ('units','list') THEN
   SELECT * INTO c FROM ertad.channels WHERE organization_id=org AND id=(input->>'id')::uuid;
   permission:=CASE WHEN op='post' THEN 'channel.post' WHEN op='archive' THEN 'channel.manage' WHEN op IN ('reports','resolve') THEN 'channel.moderate' ELSE 'channel.read' END;
   IF NOT FOUND OR NOT ertad.channel_allowed(actor,c,permission) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Channel unavailable'; END IF;
   target:=c.unit_id;
  END IF;
  IF writing THEN
   IF fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' OR input->>'key' IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Request identity required'; END IF;
   SELECT * INTO receipt FROM ertad.channel_receipts WHERE organization_id=org AND actor_id=actor AND key=(input->>'key')::uuid;
   IF FOUND THEN
    IF receipt.fingerprint<>fingerprint THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Retry conflict'; END IF;
    RETURN jsonb_build_object('data',receipt.response,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'changed',false));
   END IF;
  END IF;
  IF op IN ('work','work-create') THEN
   SELECT * INTO c FROM ertad.channels WHERE organization_id=org AND work_id=w.id;
   IF op='work' THEN
    result:=jsonb_build_object('id',c.id,'canCreate',c.id IS NULL AND ertad.work_channel_allowed(actor,w,'channel.manage'));
   ELSE
    IF c.id IS NULL THEN
     INSERT INTO ertad.channels(organization_id,unit_id,scope_path,title,creator_id,work_id)
     VALUES(org,w.unit_id,w.scope_path,left(w.title,120),actor,w.id) RETURNING * INTO c;
    END IF;
    result:=jsonb_build_object('id',c.id);
   END IF;
  ELSIF op='units' THEN
   SELECT jsonb_build_object('items',COALESCE(jsonb_agg(jsonb_build_object('id',u.id,'name',u.name) ORDER BY u.name,u.id),'[]'),'page',page) INTO result
   FROM (SELECT * FROM ertad.units u WHERE organization_id=org AND ertad.review_has_scope(actor,org,u.id,'channel.manage') AND ertad.review_has_scope(actor,org,u.id,'channel.read') ORDER BY name,id LIMIT 25 OFFSET(page-1)*25) u;
  ELSIF op='list' THEN
   IF COALESCE(input->>'view','active') NOT IN ('active','archived','unread') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid view'; END IF;
   WITH visible AS MATERIALIZED(SELECT ertad.channel_view(actor,ch) v FROM ertad.channels ch WHERE ch.organization_id=org AND ertad.channel_allowed(actor,ch)),
   filtered AS(SELECT v FROM visible WHERE CASE COALESCE(input->>'view','active') WHEN 'archived' THEN (v->>'archived')::boolean WHEN 'unread' THEN NOT (v->>'archived')::boolean AND (v->>'unread')::int>0 ELSE NOT (v->>'archived')::boolean END),
   paged AS(SELECT v FROM filtered ORDER BY v->>'title',v->>'id' LIMIT 25 OFFSET(page-1)*25)
   SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(v ORDER BY v->>'title',v->>'id') FROM paged),'[]'),'total',(SELECT count(*) FROM filtered),'page',page) INTO result;
  ELSIF op='thread' THEN
   WITH paged AS(SELECT * FROM ertad.channel_messages x WHERE organization_id=org AND channel_id=c.id AND (before_seq=0 OR seq<before_seq) ORDER BY seq DESC LIMIT 40)
   SELECT jsonb_build_object('channel',ertad.channel_view(actor,c),'items',COALESCE(jsonb_agg(jsonb_build_object('id',x.id,'seq',x.seq,'body',x.body,'removed',x.removed,'mine',x.author_id=actor,
    'authorTag',(SELECT min(seq) FROM ertad.channel_messages WHERE organization_id=org AND channel_id=c.id AND author_id=x.author_id),
    'replySeq',(SELECT seq FROM ertad.channel_messages WHERE organization_id=org AND channel_id=c.id AND id=x.reply_id),'createdAt',x.created_at) ORDER BY x.seq),'[]'),
    'hasOlder',COALESCE((SELECT min(seq) FROM ertad.channel_messages WHERE organization_id=org AND channel_id=c.id)<min(x.seq),false)) INTO result FROM paged x;
  ELSIF op='reports' THEN
   WITH visible AS(SELECT p.*,x.seq,x.body,x.removed FROM ertad.channel_reports p JOIN ertad.channel_messages x ON x.organization_id=p.organization_id AND x.channel_id=p.channel_id AND x.id=p.message_id
    WHERE p.organization_id=org AND p.channel_id=c.id AND p.outcome IS NULL AND p.reporter_id<>actor AND x.author_id<>actor),
   paged AS(SELECT * FROM visible ORDER BY created_at,id LIMIT 25 OFFSET(page-1)*25)
   SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'seq',seq,'body',body,'removed',removed,'category',category) ORDER BY created_at,id) FROM paged),'[]'),'total',(SELECT count(*) FROM visible),'page',page) INTO result;
  ELSIF op='create' THEN
   IF length(trim(COALESCE(input->>'title',''))) NOT BETWEEN 3 AND 120 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid title'; END IF;
   IF (SELECT count(*) FROM ertad.channels WHERE organization_id=org AND work_id IS NULL AND unit_id=target AND NOT archived)>=50 THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Active channel limit'; END IF;
   INSERT INTO ertad.channels(organization_id,unit_id,scope_path,title,creator_id) VALUES(org,target,ertad.unit_path(org,target),trim(input->>'title'),actor) RETURNING id INTO newid;
   result:=jsonb_build_object('id',newid);
  ELSIF op='post' THEN
   IF c.archived THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Channel archived'; END IF;
   IF length(trim(COALESCE(input->>'body',''))) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid message'; END IF;
   IF (SELECT count(*) FROM ertad.channel_messages WHERE organization_id=org AND author_id=actor AND created_at>clock_timestamp()-interval '1 minute')>=20 THEN RAISE EXCEPTION USING ERRCODE='P0429',MESSAGE='Message rate exceeded'; END IF;
   IF input->>'replyId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ertad.channel_messages WHERE organization_id=org AND channel_id=c.id AND id=(input->>'replyId')::uuid AND NOT removed) THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Reply unavailable'; END IF;
   UPDATE ertad.channels SET last_seq=last_seq+1 WHERE organization_id=org AND id=c.id RETURNING * INTO c;
   INSERT INTO ertad.channel_messages(organization_id,channel_id,seq,author_id,body,reply_id) VALUES(org,c.id,c.last_seq,actor,trim(input->>'body'),(input->>'replyId')::uuid) RETURNING id INTO newid;
   result:=jsonb_build_object('id',c.id,'messageId',newid,'seq',c.last_seq);
  ELSIF op IN ('read','mute') THEN
   observed:=COALESCE((input->>'seq')::int,0);
   IF observed<0 OR observed>c.last_seq THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Observed sequence required'; END IF;
   INSERT INTO ertad.channel_reads VALUES(org,c.id,actor,0,false) ON CONFLICT DO NOTHING;
   IF op='read' THEN UPDATE ertad.channel_reads SET read_seq=greatest(read_seq,observed) WHERE organization_id=org AND channel_id=c.id AND user_id=actor;
   ELSE UPDATE ertad.channel_reads SET muted=(input->>'muted')::boolean WHERE organization_id=org AND channel_id=c.id AND user_id=actor; END IF;
   result:=jsonb_build_object('id',c.id);
  ELSIF op='archive' THEN
   IF c.version<>(input->>'version')::int THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Channel changed'; END IF;
   IF c.work_id IS NULL AND c.archived AND NOT (input->>'archived')::boolean AND (SELECT count(*) FROM ertad.channels WHERE organization_id=org AND work_id IS NULL AND unit_id=c.unit_id AND NOT archived)>=50 THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Active channel limit'; END IF;
   UPDATE ertad.channels SET archived=(input->>'archived')::boolean,version=version+1 WHERE organization_id=org AND id=c.id;
   result:=jsonb_build_object('id',c.id);
  ELSIF op IN ('remove','report') THEN
   SELECT * INTO m FROM ertad.channel_messages WHERE organization_id=org AND channel_id=c.id AND id=(input->>'messageId')::uuid;
   IF NOT FOUND OR (op='remove' AND m.author_id<>actor) OR (op='report' AND m.author_id=actor) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Message action unavailable'; END IF;
   IF op='remove' THEN
    IF NOT m.removed THEN UPDATE ertad.channel_messages SET body='',removed=true WHERE organization_id=org AND channel_id=c.id AND id=m.id; END IF;
   ELSE
    IF m.removed THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Message removed'; END IF;
    INSERT INTO ertad.channel_reports(organization_id,channel_id,message_id,reporter_id,category) VALUES(org,c.id,m.id,actor,input->>'category') ON CONFLICT(organization_id,channel_id,message_id,reporter_id) DO NOTHING;
   END IF;result:=jsonb_build_object('id',c.id);
  ELSIF op='resolve' THEN
   SELECT * INTO r FROM ertad.channel_reports WHERE organization_id=org AND channel_id=c.id AND id=(input->>'reportId')::uuid;
   SELECT * INTO m FROM ertad.channel_messages WHERE organization_id=org AND channel_id=c.id AND id=r.message_id;
   IF r.id IS NULL OR r.reporter_id=actor OR m.author_id=actor THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Independent moderator required'; END IF;
   IF r.outcome IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Report already resolved'; END IF;
   IF input->>'outcome' NOT IN ('keep','remove') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid outcome'; END IF;
   IF input->>'outcome'='remove' AND NOT m.removed THEN UPDATE ertad.channel_messages SET removed=true,body='' WHERE organization_id=org AND channel_id=c.id AND id=m.id; END IF;
   UPDATE ertad.channel_reports SET outcome=input->>'outcome',reviewer_id=actor,reviewed_at=clock_timestamp() WHERE organization_id=org AND id=r.id;
   result:=jsonb_build_object('id',c.id);
  END IF;
  IF writing THEN INSERT INTO ertad.channel_receipts VALUES(org,actor,(input->>'key')::uuid,fingerprint,result); END IF;
 END IF;
 RETURN jsonb_build_object('data',result,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'channelId',COALESCE(c.id,newid),'changed',writing));
END $$;
