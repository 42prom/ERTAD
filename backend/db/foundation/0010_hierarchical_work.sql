-- Scoped voluntary work, delegation, independent completion and durable history.
ALTER TABLE ertad.permission_grants DROP CONSTRAINT permission_grants_permission_check;
ALTER TABLE ertad.permission_grants ADD CONSTRAINT permission_grants_permission_check CHECK
 (permission IN ('unit.read','workitem.create','workitem.verify','workitem.read','workitem.participate',
 'membership.propose','membership.approve','unit.propose','unit.approve',
 'decision.read','decision.manage','decision.publish','decision.vote'));

CREATE TABLE ertad.work_items (
 organization_id uuid NOT NULL REFERENCES ertad.organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 unit_id uuid NOT NULL, parent_id uuid, creator_id uuid NOT NULL REFERENCES ertad.member_users(id),
 title text NOT NULL CHECK(length(trim(title)) BETWEEN 3 AND 160), description text NOT NULL CHECK(length(description)<=3000),
 role_label text NOT NULL CHECK(length(trim(role_label)) BETWEEN 1 AND 100),
 priority text NOT NULL CHECK(priority IN ('low','normal','high','urgent')),
 capacity integer NOT NULL CHECK(capacity BETWEEN 1 AND 100), deadline timestamptz NOT NULL CHECK(isfinite(deadline)),
 status text NOT NULL CHECK(status IN ('offered','open','completed','cancelled')),
 scope_path uuid[] NOT NULL, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,id), FOREIGN KEY(organization_id,unit_id) REFERENCES ertad.units(organization_id,id),
 FOREIGN KEY(organization_id,parent_id) REFERENCES ertad.work_items(organization_id,id)
);
CREATE INDEX work_queue ON ertad.work_items(organization_id,unit_id,status,created_at,id);
CREATE INDEX work_children ON ertad.work_items(organization_id,parent_id);
CREATE TABLE ertad.work_assignments (
 organization_id uuid NOT NULL, work_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES ertad.member_users(id),
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 status text NOT NULL CHECK(status IN ('applied','reserved','assigned','in_progress','submitted','verified','withdrawn','rejected','no_show')),
 progress integer NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
 PRIMARY KEY(organization_id,work_id,user_id), UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,work_id) REFERENCES ertad.work_items(organization_id,id)
);
CREATE TABLE ertad.work_events (
 organization_id uuid NOT NULL, work_id uuid NOT NULL, version integer NOT NULL,
 actor_id uuid NOT NULL REFERENCES ertad.member_users(id), subject_id uuid REFERENCES ertad.member_users(id),
 action text NOT NULL, note text NOT NULL CHECK(length(note)<=1000), progress integer,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(organization_id,work_id,version),
 FOREIGN KEY(organization_id,work_id) REFERENCES ertad.work_items(organization_id,id)
);
CREATE TABLE ertad.activity_entries (
 organization_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES ertad.member_users(id),
 unit_id uuid NOT NULL, assignment_id uuid NOT NULL, kind text NOT NULL CHECK(kind='task_completed'),
 verifier_id uuid NOT NULL REFERENCES ertad.member_users(id), value integer NOT NULL CHECK(value=1),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), CHECK(user_id<>verifier_id),
 PRIMARY KEY(organization_id,id), UNIQUE(organization_id,assignment_id),
 FOREIGN KEY(organization_id,unit_id) REFERENCES ertad.units(organization_id,id),
 FOREIGN KEY(organization_id,assignment_id) REFERENCES ertad.work_assignments(organization_id,id)
);
CREATE TABLE ertad.work_notifications (
 organization_id uuid NOT NULL, work_id uuid NOT NULL, version integer NOT NULL,
 recipient_id uuid NOT NULL REFERENCES ertad.member_users(id), read_at timestamptz,
 PRIMARY KEY(organization_id,work_id,version,recipient_id),
 FOREIGN KEY(organization_id,work_id,version) REFERENCES ertad.work_events(organization_id,work_id,version)
);
CREATE TABLE ertad.work_commands (
 organization_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES ertad.member_users(id), key uuid NOT NULL,
 work_id uuid NOT NULL, operation text NOT NULL, payload jsonb NOT NULL, response jsonb NOT NULL,
 PRIMARY KEY(organization_id,actor_id,key), FOREIGN KEY(organization_id,work_id) REFERENCES ertad.work_items(organization_id,id)
);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['work_events','activity_entries','work_commands'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON ertad.%I FOR EACH ROW EXECUTE FUNCTION ertad.prevent_audit_log_mutation()',tab);
  EXECUTE format('CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON ertad.%I FOR EACH STATEMENT EXECUTE FUNCTION ertad.prevent_audit_log_mutation()',tab);
 END LOOP;
END $$;

CREATE FUNCTION ertad.work_visible(actor uuid,w ertad.work_items) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT w.scope_path=ertad.unit_path(w.organization_id,w.unit_id)
 AND ertad.review_has_scope(actor,w.organization_id,w.unit_id,'workitem.read');
$$;
CREATE FUNCTION ertad.work_used(w ertad.work_items) RETURNS integer
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT (SELECT count(*) FROM ertad.work_assignments a WHERE a.organization_id=w.organization_id AND a.work_id=w.id
 AND a.status IN ('assigned','in_progress','submitted','verified'))::integer
 +COALESCE((SELECT sum(c.capacity) FROM ertad.work_items c WHERE c.organization_id=w.organization_id AND c.parent_id=w.id AND c.status<>'cancelled'),0)::integer;
$$;
CREATE FUNCTION ertad.work_view(actor uuid,w ertad.work_items) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',w.id,'unitId',w.unit_id,'parentId',w.parent_id,'title',w.title,'description',w.description,
 'unitName',(SELECT name FROM ertad.units WHERE organization_id=w.organization_id AND id=w.unit_id),
 'roleLabel',w.role_label,'priority',w.priority,'capacity',w.capacity,'used',ertad.work_used(w),'deadline',w.deadline,
 'status',w.status,'version',w.version,'actorId',actor,
 'canManage',ertad.review_has_scope(actor,w.organization_id,w.unit_id,'workitem.create'),
 'canVerify',ertad.review_has_scope(actor,w.organization_id,w.unit_id,'workitem.verify'),
 'canParticipate',ertad.review_has_scope(actor,w.organization_id,w.unit_id,'workitem.participate'),
 'verified',(SELECT count(*) FROM ertad.work_assignments WHERE organization_id=w.organization_id AND work_id=w.id AND status='verified'),
 'unread',(SELECT count(*) FROM ertad.work_notifications WHERE organization_id=w.organization_id AND work_id=w.id AND recipient_id=actor AND read_at IS NULL));
$$;

CREATE FUNCTION ertad.work_authorize(actor uuid,org uuid,op text,input jsonb) RETURNS uuid
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE w ertad.work_items; target uuid; permission text;
BEGIN
 IF op='create' THEN target:=(input->>'unitId')::uuid;
 ELSE
  SELECT * INTO w FROM ertad.work_items WHERE organization_id=org AND id=(input->>'id')::uuid;
  IF NOT FOUND OR NOT ertad.work_visible(actor,w) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
  target:=w.unit_id;
 END IF;
 permission:=CASE WHEN op IN ('apply','withdraw','start','progress','submit') THEN 'workitem.participate'
 WHEN op IN ('verify','return') THEN 'workitem.verify' WHEN op IN ('detail','ack') THEN 'workitem.read' ELSE 'workitem.create' END;
 IF NOT ertad.review_has_scope(actor,org,target,'workitem.read') OR NOT ertad.review_has_scope(actor,org,target,permission) THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 IF op IN ('assign','reserve','verify','return') AND (NOT ertad.review_has_scope((input->>'memberId')::uuid,org,target,'workitem.participate')
  OR NOT ertad.review_has_scope((input->>'memberId')::uuid,org,target,'workitem.read')) THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Participant no longer eligible'; END IF;
 RETURN target;
END $$;

CREATE FUNCTION ertad.work_command(sid uuid,token text,op text,org uuid,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_column
DECLARE actor uuid; w ertad.work_items; child ertad.work_items; a ertad.work_assignments; receipt ertad.work_commands;
 result jsonb; mutation boolean; changed boolean:=false; target uuid; subject uuid; note text; n integer; next_status text;
BEGIN
 IF op NOT IN ('contexts','units','list','detail','create','delegate','accept','decline','cancel','complete','apply','reserve','assign','reject','withdraw','start','progress','submit','return','verify','no_show','ack') THEN
  RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid operation'; END IF;
 mutation:=op NOT IN ('contexts','units','list','detail');
 actor:=ertad.review_identity(sid,token,mutation AND op<>'ack');
 IF op='contexts' THEN
  PERFORM 1 FROM ertad.organizations o WHERE EXISTS(SELECT 1 FROM ertad.memberships m WHERE m.organization_id=o.id AND m.user_id=actor) ORDER BY o.id FOR SHARE;
 ELSIF mutation THEN
  PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 ELSE
  PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 END IF;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint);
 PERFORM ertad.review_identity(sid,token,mutation AND op<>'ack');
 IF op='contexts' THEN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',o.id,'name',o.name)),'[]') INTO result FROM ertad.organizations o
  WHERE o.status='active' AND EXISTS(SELECT 1 FROM ertad.units u WHERE u.organization_id=o.id AND ertad.review_has_scope(actor,o.id,u.id,'workitem.read'));
 ELSIF op='units' THEN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',u.id,'name',u.name,'parentId',u.parent_id,
   'canCreate',ertad.review_has_scope(actor,org,u.id,'workitem.create')) ORDER BY u.name,u.id),'[]') INTO result
  FROM ertad.units u WHERE u.organization_id=org AND u.kind='authority' AND ertad.review_has_scope(actor,org,u.id,'workitem.read');
 ELSIF op='list' THEN
  n:=COALESCE((input->>'page')::integer,1);
  IF n NOT BETWEEN 1 AND 1000 OR COALESCE(input->>'view','open') NOT IN ('open','offered','completed','cancelled','mine','inbox') OR length(COALESCE(input->>'search',''))>80 THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid filter'; END IF;
  WITH visible AS (SELECT w.* FROM ertad.work_items w WHERE w.organization_id=org AND ertad.work_visible(actor,w)
   AND position(lower(COALESCE(input->>'search','')) in lower(w.title))>0
   AND CASE WHEN input->>'view'='mine' THEN EXISTS(SELECT 1 FROM ertad.work_assignments a WHERE a.organization_id=org AND a.work_id=w.id AND a.user_id=actor)
    WHEN input->>'view'='inbox' THEN EXISTS(SELECT 1 FROM ertad.work_notifications nt WHERE nt.organization_id=org AND nt.work_id=w.id AND nt.recipient_id=actor AND nt.read_at IS NULL)
    ELSE w.status=COALESCE(input->>'view','open') END),
   paged AS (SELECT * FROM visible ORDER BY created_at DESC,id LIMIT 25 OFFSET (n-1)*25)
  SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(ertad.work_view(actor,paged::ertad.work_items) ORDER BY created_at DESC,id) FROM paged),'[]'),
   'total',(SELECT count(*) FROM visible),'page',n,'pageSize',25) INTO result;
 ELSE
  target:=ertad.work_authorize(actor,org,op,input);
  IF op<>'create' THEN SELECT * INTO w FROM ertad.work_items WHERE organization_id=org AND id=(input->>'id')::uuid; END IF;
  IF mutation AND op<>'ack' THEN
   SELECT * INTO receipt FROM ertad.work_commands WHERE organization_id=org AND actor_id=actor AND key=(input->>'key')::uuid;
   IF FOUND THEN
    IF receipt.operation<>op OR receipt.payload<>input-'key' THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Retry conflict'; END IF;
    RETURN jsonb_build_object('data',receipt.response,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'workId',receipt.work_id,'changed',false));
   END IF;
   IF op<>'create' AND w.version IS DISTINCT FROM (input->>'version')::integer THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Stale version'; END IF;
  END IF;
  IF op='detail' THEN
   result:=ertad.work_view(actor,w)||jsonb_build_object(
    'assignments',COALESCE((SELECT jsonb_agg(jsonb_build_object('memberId',a.user_id,'status',a.status,'progress',a.progress) ORDER BY a.user_id)
     FROM ertad.work_assignments a WHERE a.organization_id=org AND a.work_id=w.id AND (a.user_id=actor OR ertad.review_has_scope(actor,org,target,'workitem.create') OR ertad.review_has_scope(actor,org,target,'workitem.verify'))),'[]'),
    'events',COALESCE((SELECT jsonb_agg(jsonb_build_object('version',e.version,'action',e.action,'at',e.created_at,'note',e.note,'progress',e.progress,'actorId',e.actor_id,'subjectId',e.subject_id) ORDER BY e.version DESC)
     FROM (SELECT * FROM ertad.work_events e WHERE e.organization_id=org AND e.work_id=w.id
      AND (e.subject_id IS NULL OR e.subject_id=actor OR ertad.review_has_scope(actor,org,target,'workitem.create') OR ertad.review_has_scope(actor,org,target,'workitem.verify')) ORDER BY version DESC LIMIT 100) e),'[]'),
    'children',COALESCE((SELECT jsonb_agg(ertad.work_view(actor,c) ORDER BY c.created_at,c.id) FROM ertad.work_items c WHERE c.organization_id=org AND c.parent_id=w.id AND ertad.work_visible(actor,c)),'[]'));
  ELSIF op='ack' THEN
   UPDATE ertad.work_notifications SET read_at=clock_timestamp() WHERE organization_id=org AND work_id=w.id AND recipient_id=actor AND version<=(input->>'version')::integer AND read_at IS NULL;
   result:=jsonb_build_object('id',w.id);
  ELSE
   note:=trim(COALESCE(input->>'note',''));
   IF length(note)>1000 OR (op IN ('decline','cancel','reject','return','no_show') AND length(note)<3) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Reason required'; END IF;
   IF op IN ('create','delegate') THEN
    IF op='create' AND NOT EXISTS(SELECT 1 FROM ertad.units WHERE organization_id=org AND id=target AND kind='authority' AND status='active') THEN
     RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Active authority unit required'; END IF;
    IF length(trim(COALESCE(input->>'title',''))) NOT BETWEEN 3 AND 160 OR length(COALESCE(input->>'description',''))>3000
     OR length(trim(COALESCE(input->>'roleLabel',''))) NOT BETWEEN 1 AND 100 OR COALESCE((input->>'capacity')::integer,0) NOT BETWEEN 1 AND 100
     OR (input->>'deadline') IS NULL OR (input->>'deadline')::timestamptz<=clock_timestamp() OR (input->>'deadline')::timestamptz>clock_timestamp()+interval '365 days' THEN
     RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid definition'; END IF;
    IF op='delegate' THEN
     IF w.status<>'open' OR w.deadline<=clock_timestamp() OR ertad.work_used(w)+(input->>'capacity')::integer>w.capacity
      OR (input->>'deadline')::timestamptz>w.deadline THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Allocation unavailable'; END IF;
     target:=(input->>'unitId')::uuid;
     IF NOT EXISTS(SELECT 1 FROM ertad.units WHERE organization_id=org AND id=target AND parent_id=w.unit_id AND status='active' AND kind='authority')
      OR NOT ertad.review_has_scope(actor,org,target,'workitem.create') OR NOT ertad.review_has_scope(actor,org,target,'workitem.read') THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Child scope required'; END IF;
    END IF;
    INSERT INTO ertad.work_items(organization_id,unit_id,parent_id,creator_id,title,description,role_label,priority,capacity,deadline,status,scope_path)
     VALUES(org,target,CASE WHEN op='delegate' THEN w.id END,actor,trim(input->>'title'),COALESCE(input->>'description',''),trim(input->>'roleLabel'),input->>'priority',
      (input->>'capacity')::integer,(input->>'deadline')::timestamptz,CASE WHEN op='delegate' THEN 'offered' ELSE 'open' END,ertad.unit_path(org,target)) RETURNING * INTO child;
    IF op='delegate' THEN
     UPDATE ertad.work_items SET version=version+1 WHERE organization_id=org AND id=w.id RETURNING * INTO w;
     INSERT INTO ertad.work_events VALUES(org,w.id,w.version,actor,NULL,'delegate',note,NULL,clock_timestamp());
    END IF;
    w:=child;
   ELSE
    IF w.status IN ('completed','cancelled') THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Task finished'; END IF;
    IF op IN ('accept','decline') THEN
     IF w.status<>'offered' OR (op='accept' AND (w.deadline<=clock_timestamp() OR COALESCE((input->>'capacity')::integer,0) NOT BETWEEN 1 AND w.capacity)) THEN
      RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Offer unavailable'; END IF;
     UPDATE ertad.work_items SET status=CASE WHEN op='accept' THEN 'open' ELSE 'cancelled' END,
      capacity=CASE WHEN op='accept' THEN (input->>'capacity')::integer ELSE capacity END WHERE organization_id=org AND id=w.id;
    ELSIF op IN ('cancel','complete') THEN
     IF EXISTS(SELECT 1 FROM ertad.work_items WHERE organization_id=org AND parent_id=w.id AND status IN ('offered','open')) THEN
      RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Finish children first'; END IF;
     IF op='complete' AND (w.status<>'open' OR EXISTS(SELECT 1 FROM ertad.work_assignments WHERE organization_id=org AND work_id=w.id AND status IN ('assigned','in_progress','submitted'))
      OR NOT (EXISTS(SELECT 1 FROM ertad.work_assignments WHERE organization_id=org AND work_id=w.id AND status='verified')
        OR EXISTS(SELECT 1 FROM ertad.work_items WHERE organization_id=org AND parent_id=w.id AND status='completed'))) THEN
      RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Verified completion required'; END IF;
     -- Cancellation cannot release capacity already consumed by verified work.
     IF op='cancel' AND (EXISTS(SELECT 1 FROM ertad.work_assignments WHERE organization_id=org AND work_id=w.id AND status='verified')
       OR EXISTS(SELECT 1 FROM ertad.work_items WHERE organization_id=org AND parent_id=w.id AND status='completed')) THEN
      RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Complete verified work instead'; END IF;
     UPDATE ertad.work_items SET status=CASE WHEN op='cancel' THEN 'cancelled' ELSE 'completed' END WHERE organization_id=org AND id=w.id;
     UPDATE ertad.work_assignments SET status='withdrawn' WHERE organization_id=org AND work_id=w.id AND status IN ('applied','reserved','assigned','in_progress','submitted');
    ELSE
     IF w.status<>'open' OR (op IN ('apply','reserve','assign') AND w.deadline<=clock_timestamp()) THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Task unavailable'; END IF;
     subject:=CASE WHEN op IN ('apply','withdraw','start','progress','submit') THEN actor ELSE (input->>'memberId')::uuid END;
     SELECT * INTO a FROM ertad.work_assignments WHERE organization_id=org AND work_id=w.id AND user_id=subject;
     IF op='apply' THEN
      IF FOUND THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Already applied'; END IF;
      INSERT INTO ertad.work_assignments(organization_id,work_id,user_id,status) VALUES(org,w.id,actor,'applied');
     ELSE
      IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Application required'; END IF;
      next_status:=CASE
       WHEN op='reserve' AND a.status='applied' THEN 'reserved'
       WHEN op='assign' AND a.status IN ('applied','reserved') THEN 'assigned'
       WHEN op='reject' AND a.status IN ('applied','reserved') THEN 'rejected'
       WHEN op='withdraw' AND a.status IN ('applied','reserved','assigned','in_progress','submitted') THEN 'withdrawn'
       WHEN op='start' AND a.status='assigned' THEN 'in_progress'
       WHEN op='progress' AND a.status='in_progress' THEN 'in_progress'
       WHEN op='submit' AND a.status='in_progress' THEN 'submitted'
       WHEN op='return' AND a.status='submitted' THEN 'in_progress'
       WHEN op='verify' AND a.status='submitted' AND actor<>subject THEN 'verified'
       WHEN op='no_show' AND a.status IN ('assigned','in_progress') THEN 'no_show' END;
      IF next_status IS NULL OR (op='assign' AND ertad.work_used(w)>=w.capacity) THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Transition unavailable'; END IF;
      IF op='progress' AND (COALESCE((input->>'progress')::integer,-1) NOT BETWEEN 0 AND 100 OR length(note)<3) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Progress and note required'; END IF;
      UPDATE ertad.work_assignments SET status=next_status,progress=CASE WHEN op IN ('submit','verify') THEN 100 WHEN op='progress' THEN (input->>'progress')::integer ELSE progress END
       WHERE organization_id=org AND work_id=w.id AND user_id=subject;
      IF op='verify' THEN
       INSERT INTO ertad.activity_entries(organization_id,user_id,unit_id,assignment_id,kind,verifier_id,value) VALUES(org,subject,w.unit_id,a.id,'task_completed',actor,1);
      END IF;
     END IF;
    END IF;
    UPDATE ertad.work_items SET version=version+1 WHERE organization_id=org AND id=w.id RETURNING * INTO w;
   END IF;
   INSERT INTO ertad.work_events VALUES(org,w.id,w.version,actor,subject,op,note,CASE WHEN op='progress' THEN (input->>'progress')::integer END,clock_timestamp());
   -- Persist IDs only. Every later projection rechecks the recipient's current scope.
   INSERT INTO ertad.work_notifications(organization_id,work_id,version,recipient_id)
    SELECT org,w.id,w.version,u.id FROM ertad.member_users u WHERE u.id<>actor AND u.status='active' AND ertad.work_visible(u.id,w)
    AND (u.id=w.creator_id OR u.id=subject OR ertad.review_has_scope(u.id,org,w.unit_id,'workitem.create') OR ertad.review_has_scope(u.id,org,w.unit_id,'workitem.verify')
     OR (subject IS NULL AND EXISTS(SELECT 1 FROM ertad.work_assignments a WHERE a.organization_id=org AND a.work_id=w.id AND a.user_id=u.id)));
   result:=jsonb_build_object('id',w.id,'version',w.version); changed:=true;
   INSERT INTO ertad.work_commands VALUES(org,actor,(input->>'key')::uuid,w.id,op,input-'key',result);
  END IF;
 END IF;
 RETURN jsonb_build_object('data',result,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'workId',w.id,'changed',changed));
END $$;

CREATE FUNCTION ertad.work_finish(sid uuid,token text,op text,org uuid,input jsonb,changed boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid; target uuid; w ertad.work_items;
BEGIN
 actor:=ertad.review_identity(sid,token,op<>'ack');
 target:=ertad.work_authorize(actor,org,op,input);
 IF op='delegate' AND (NOT ertad.review_has_scope(actor,org,(input->>'unitId')::uuid,'workitem.create') OR
   NOT ertad.review_has_scope(actor,org,(input->>'unitId')::uuid,'workitem.read')) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 IF changed AND op IN ('create','delegate','accept','apply','assign','reserve') THEN
  IF op IN ('create','delegate') THEN
   IF (input->>'deadline')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Deadline passed'; END IF;
  ELSE
   SELECT * INTO w FROM ertad.work_items WHERE organization_id=org AND id=(input->>'id')::uuid;
   IF w.deadline<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Deadline passed'; END IF;
  END IF;
 END IF;
END $$;
REVOKE ALL ON ertad.work_items,ertad.work_assignments,ertad.work_events,ertad.work_commands,ertad.work_notifications,ertad.activity_entries FROM PUBLIC,ertad_app;
REVOKE ALL ON FUNCTION ertad.work_visible(uuid,ertad.work_items),ertad.work_used(ertad.work_items),ertad.work_view(uuid,ertad.work_items),ertad.work_authorize(uuid,uuid,text,jsonb),
 ertad.work_command(uuid,text,text,uuid,jsonb),ertad.work_finish(uuid,text,text,uuid,jsonb,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.work_command(uuid,text,text,uuid,jsonb),ertad.work_finish(uuid,text,text,uuid,jsonb,boolean) TO ertad_app;
