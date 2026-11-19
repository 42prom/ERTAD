-- Amend an open task without replacing its participation, verification or reward source.
CREATE FUNCTION ertad.work_definition_snapshot(w ertad.work_items) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('title',w.title,'description',w.description,'priority',w.priority,
  'capacity',w.capacity,'deadline',w.deadline,'startsAt',w.starts_at,'location',w.location)
$$;

ALTER FUNCTION ertad.work_command(uuid,text,text,uuid,jsonb) RENAME TO work_before_editing_command;
CREATE FUNCTION ertad.work_command(sid uuid,token text,op text,org uuid,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb; actor uuid; w ertad.work_items; previous ertad.work_items;
 receipt ertad.work_commands; fingerprint jsonb; due timestamptz; starts timestamptz; places integer;
BEGIN
 IF op<>'edit' THEN RETURN ertad.work_before_editing_command(sid,token,op,org,input); END IF;
 actor:=ertad.review_identity(sid,token,true);
 PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint);
 PERFORM ertad.review_identity(sid,token,true);
 PERFORM ertad.work_authorize(actor,org,op,input);
 SELECT * INTO w FROM ertad.work_items WHERE organization_id=org AND id=(input->>'id')::uuid;
 fingerprint:=jsonb_build_object('sha256',encode(sha256(convert_to((input-'key')::text,'UTF8')),'hex'));
 SELECT * INTO receipt FROM ertad.work_commands WHERE organization_id=org AND actor_id=actor AND key=(input->>'key')::uuid;
 IF FOUND THEN
  IF receipt.operation<>op OR receipt.payload<>fingerprint THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Retry conflict'; END IF;
  RETURN jsonb_build_object('data',receipt.response,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'workId',w.id,'changed',false));
 END IF;
 IF w.version IS DISTINCT FROM (input->>'version')::integer OR w.status<>'open' THEN
  RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Task changed or closed'; END IF;
 IF input-ARRAY['organizationId','id','key','version','note','title','description','priority','capacity','deadline','startsAt','location']<>'{}'::jsonb
  OR NOT input ?& ARRAY['title','description','priority','capacity','deadline','startsAt','location','note']
  OR jsonb_typeof(input->'title') IS DISTINCT FROM 'string' OR length(trim(input->>'title')) NOT BETWEEN 3 AND 160
  OR jsonb_typeof(input->'description') IS DISTINCT FROM 'string' OR length(input->>'description')>3000
  OR COALESCE(input->>'priority','') NOT IN ('low','normal','high','urgent')
  OR jsonb_typeof(input->'capacity') IS DISTINCT FROM 'number' OR (input->>'capacity') !~ '^[0-9]+$'
  OR jsonb_typeof(input->'location') IS DISTINCT FROM 'string' OR length(trim(input->>'location'))>300
  OR jsonb_typeof(input->'note') IS DISTINCT FROM 'string' OR length(trim(input->>'note')) NOT BETWEEN 3 AND 1000
  OR jsonb_typeof(input->'deadline') IS DISTINCT FROM 'string'
  OR jsonb_typeof(input->'startsAt') NOT IN ('string','null') THEN
  RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid task definition'; END IF;
 due:=(input->>'deadline')::timestamptz; starts:=(input->>'startsAt')::timestamptz; places:=(input->>'capacity')::integer;
 IF NOT isfinite(due) OR places NOT BETWEEN 1 AND 100 OR (starts IS NOT NULL AND (NOT isfinite(starts) OR starts>due))
  OR (due IS DISTINCT FROM w.deadline AND (due<=clock_timestamp() OR due>clock_timestamp()+interval '365 days')) THEN
  RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid capacity or schedule'; END IF;
 -- Receivers cannot increase an upstream allocation; accepting an offer remains the existing workflow.
 IF (w.parent_id IS NOT NULL AND places<>w.capacity) OR places<ertad.work_used(w)
  OR places<COALESCE((SELECT sum(quantity) FROM ertad.work_needs WHERE organization_id=org AND work_id=w.id AND kind='people' AND NOT cancelled),0)
  OR (due IS DISTINCT FROM w.deadline AND (
   EXISTS(SELECT 1 FROM ertad.work_items WHERE organization_id=org AND id=w.parent_id AND deadline<due)
   OR EXISTS(SELECT 1 FROM ertad.work_items WHERE organization_id=org AND parent_id=w.id AND status IN ('open','offered') AND deadline>due)
   OR EXISTS(SELECT 1 FROM ertad.work_needs WHERE organization_id=org AND work_id=w.id AND NOT cancelled AND deadline>due))) THEN
  RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Existing allocation or deadline would be violated'; END IF;
 previous:=w;
 UPDATE ertad.work_items SET title=trim(input->>'title'),description=input->>'description',priority=input->>'priority',
  capacity=places,deadline=due,starts_at=starts,location=trim(input->>'location'),version=version+1
  WHERE organization_id=org AND id=w.id RETURNING * INTO w;
 IF ertad.work_definition_snapshot(previous)=ertad.work_definition_snapshot(w) THEN
  RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='No task changes'; END IF;
 INSERT INTO ertad.work_events(organization_id,work_id,version,actor_id,action,note,details,created_at)
  VALUES(org,w.id,w.version,actor,'edit',trim(input->>'note'),jsonb_build_object('before',ertad.work_definition_snapshot(previous),'after',ertad.work_definition_snapshot(w)),clock_timestamp());
 INSERT INTO ertad.work_notifications(organization_id,work_id,version,recipient_id)
  SELECT org,w.id,w.version,u.id FROM ertad.member_users u WHERE u.id<>actor AND u.status='active' AND ertad.work_visible(u.id,w)
  AND (u.id=w.creator_id OR ertad.review_has_scope(u.id,org,w.unit_id,'workitem.create') OR ertad.review_has_scope(u.id,org,w.unit_id,'workitem.verify')
   OR EXISTS(SELECT 1 FROM ertad.work_assignments a WHERE a.organization_id=org AND a.work_id=w.id AND a.user_id=u.id));
 result:=jsonb_build_object('id',w.id,'version',w.version);
 INSERT INTO ertad.work_commands VALUES(org,actor,(input->>'key')::uuid,w.id,op,fingerprint,result);
 RETURN jsonb_build_object('data',result,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'workId',w.id,'changed',true,
  'deadlineChanged',due IS DISTINCT FROM previous.deadline));
END $$;

ALTER FUNCTION ertad.work_finish(uuid,text,text,uuid,jsonb,boolean) RENAME TO work_before_editing_finish;
CREATE FUNCTION ertad.work_finish(sid uuid,token text,op text,org uuid,input jsonb,changed boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM ertad.work_before_editing_finish(sid,token,op,org,input,changed);
 IF op='edit' AND changed AND EXISTS(SELECT 1 FROM ertad.work_events e WHERE e.organization_id=org AND e.work_id=(input->>'id')::uuid
  AND e.version=(input->>'version')::integer+1 AND e.action='edit'
  AND e.details->'before'->>'deadline' IS DISTINCT FROM e.details->'after'->>'deadline')
  AND (input->>'deadline')::timestamptz<=clock_timestamp() THEN
  RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Deadline passed'; END IF;
END $$;
REVOKE ALL ON FUNCTION ertad.work_definition_snapshot(ertad.work_items),ertad.work_before_editing_command(uuid,text,text,uuid,jsonb),
 ertad.work_before_editing_finish(uuid,text,text,uuid,jsonb,boolean) FROM PUBLIC,ertad_app;
REVOKE ALL ON FUNCTION ertad.work_command(uuid,text,text,uuid,jsonb),ertad.work_finish(uuid,text,text,uuid,jsonb,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.work_command(uuid,text,text,uuid,jsonb),ertad.work_finish(uuid,text,text,uuid,jsonb,boolean) TO ertad_app;
