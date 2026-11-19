-- Operational oversight extends the existing Work command transaction.
ALTER TABLE ertad.work_items ADD COLUMN coordinator_id uuid REFERENCES ertad.member_users(id);
UPDATE ertad.work_items SET coordinator_id=creator_id;
ALTER TABLE ertad.work_events ADD COLUMN details jsonb NOT NULL DEFAULT '{}';
CREATE FUNCTION ertad.work_default_coordinator() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN NEW.coordinator_id:=COALESCE(NEW.coordinator_id,NEW.creator_id); RETURN NEW; END $$;
CREATE TRIGGER work_default_coordinator BEFORE INSERT ON ertad.work_items FOR EACH ROW EXECUTE FUNCTION ertad.work_default_coordinator();
CREATE TABLE ertad.work_criteria (
 organization_id uuid NOT NULL, work_id uuid NOT NULL, id uuid NOT NULL,
 title text NOT NULL CHECK(length(trim(title)) BETWEEN 3 AND 160), weight integer NOT NULL CHECK(weight BETWEEN 1 AND 100),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','submitted','verified')),
 submitted_by uuid REFERENCES ertad.member_users(id), verified_by uuid REFERENCES ertad.member_users(id),
 submission_note text NOT NULL DEFAULT '' CHECK(length(submission_note)<=1000),
 review_note text NOT NULL DEFAULT '' CHECK(length(review_note)<=1000),
 PRIMARY KEY(organization_id,work_id,id), FOREIGN KEY(organization_id,work_id) REFERENCES ertad.work_items(organization_id,id),
 CHECK(status='pending' OR submitted_by IS NOT NULL),
 CHECK((status='verified')=(verified_by IS NOT NULL)), CHECK(verified_by IS NULL OR verified_by<>submitted_by)
);
CREATE TABLE ertad.work_blockers (
 organization_id uuid NOT NULL, work_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
 kind text NOT NULL CHECK(kind IN ('people','resource','service','funding','dependency','other')),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 1000),
 next_action text NOT NULL DEFAULT '' CHECK(length(next_action)<=1000),
 owner_id uuid NOT NULL REFERENCES ertad.member_users(id), reporter_id uuid NOT NULL REFERENCES ertad.member_users(id),
 next_review_at timestamptz NOT NULL CHECK(isfinite(next_review_at)),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), resolved_by uuid REFERENCES ertad.member_users(id),
 resolved_at timestamptz, resolution text CHECK(length(trim(resolution)) BETWEEN 3 AND 1000),
 PRIMARY KEY(organization_id,work_id,id), FOREIGN KEY(organization_id,work_id) REFERENCES ertad.work_items(organization_id,id),
 CHECK((resolved_at IS NULL AND resolved_by IS NULL AND resolution IS NULL) OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND resolution IS NOT NULL))
);
CREATE INDEX work_open_blockers ON ertad.work_blockers(organization_id,work_id,next_review_at) WHERE resolved_at IS NULL;

CREATE FUNCTION ertad.work_manager(actor uuid,w ertad.work_items) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT actor IS NOT NULL AND ertad.work_visible(actor,w) AND ertad.review_has_scope(actor,w.organization_id,w.unit_id,'workitem.create');
$$;
CREATE FUNCTION ertad.work_contributor(actor uuid,w ertad.work_items) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT ertad.work_manager(actor,w) OR (ertad.work_visible(actor,w) AND ertad.review_has_scope(actor,w.organization_id,w.unit_id,'workitem.participate')
  AND EXISTS(SELECT 1 FROM ertad.work_assignments WHERE organization_id=w.organization_id AND work_id=w.id AND user_id=actor AND status IN ('assigned','in_progress','submitted','verified')));
$$;
CREATE FUNCTION ertad.work_local_manager(actor uuid,w ertad.work_items) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT ertad.work_manager(actor,w) AND EXISTS(SELECT 1 FROM ertad.memberships m WHERE m.organization_id=w.organization_id AND m.user_id=actor
  AND m.unit_id=w.unit_id AND m.status='active' AND m.valid_from<=clock_timestamp() AND (m.valid_until IS NULL OR m.valid_until>clock_timestamp()));
$$;
CREATE FUNCTION ertad.work_tracking(w ertad.work_items) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('coordinatorId',w.coordinator_id,'coordinatorActive',ertad.work_manager(w.coordinator_id,w),
  'criteriaTotal',(SELECT count(*) FROM ertad.work_criteria WHERE organization_id=w.organization_id AND work_id=w.id),
  'criteriaVerified',(SELECT count(*) FROM ertad.work_criteria WHERE organization_id=w.organization_id AND work_id=w.id AND status='verified'),
  'verifiedProgress',(SELECT round(100.0*COALESCE(sum(weight) FILTER(WHERE status='verified'),0)/NULLIF(sum(weight),0),1) FROM ertad.work_criteria WHERE organization_id=w.organization_id AND work_id=w.id),
  'pendingReview',(SELECT count(*) FROM ertad.work_criteria WHERE organization_id=w.organization_id AND work_id=w.id AND status='submitted')
    +(SELECT count(*) FROM ertad.work_assignments WHERE organization_id=w.organization_id AND work_id=w.id AND status='submitted'),
  'blockers',(SELECT count(*) FROM ertad.work_blockers WHERE organization_id=w.organization_id AND work_id=w.id AND resolved_at IS NULL),
  'nextReviewAt',(SELECT min(next_review_at) FROM ertad.work_blockers WHERE organization_id=w.organization_id AND work_id=w.id AND resolved_at IS NULL));
$$;
-- Traverse only currently visible children. Never include a hidden/moved branch in totals.
CREATE FUNCTION ertad.work_overview(actor uuid,org uuid,root_id uuid DEFAULT NULL,scope_unit uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH RECURSIVE branch AS (
  SELECT w.* FROM ertad.work_items w WHERE w.organization_id=org AND w.id=root_id AND ertad.work_visible(actor,w)
  UNION ALL SELECT c.* FROM ertad.work_items c JOIN branch p ON c.organization_id=p.organization_id AND c.parent_id=p.id WHERE ertad.work_visible(actor,c)
 ), visible AS (
  SELECT w.* FROM ertad.work_items w WHERE root_id IS NULL AND w.organization_id=org AND ertad.work_visible(actor,w)
   AND (scope_unit IS NULL OR scope_unit=ANY(w.scope_path))
  UNION ALL SELECT * FROM branch
 )
 SELECT jsonb_build_object('total',count(*),'active',count(*) FILTER(WHERE w.status IN ('offered','open')),
  'offered',count(*) FILTER(WHERE w.status='offered'),'completed',count(*) FILTER(WHERE w.status='completed'),
  'overdue',count(*) FILTER(WHERE w.status IN ('offered','open') AND w.deadline<=clock_timestamp()),
  'blocked',count(*) FILTER(WHERE w.status IN ('offered','open') AND EXISTS(SELECT 1 FROM ertad.work_blockers b WHERE b.organization_id=org AND b.work_id=w.id AND b.resolved_at IS NULL)),
  'reviewDue',count(*) FILTER(WHERE w.status IN ('offered','open') AND EXISTS(SELECT 1 FROM ertad.work_blockers b WHERE b.organization_id=org AND b.work_id=w.id AND b.resolved_at IS NULL AND b.next_review_at<=clock_timestamp())),
  'needsReview',count(*) FILTER(WHERE w.status='open' AND (EXISTS(SELECT 1 FROM ertad.work_criteria c WHERE c.organization_id=org AND c.work_id=w.id AND c.status='submitted')
    OR EXISTS(SELECT 1 FROM ertad.work_assignments a WHERE a.organization_id=org AND a.work_id=w.id AND a.status='submitted'))),
  'unowned',count(*) FILTER(WHERE w.status IN ('offered','open') AND NOT ertad.work_manager(w.coordinator_id,w)),
  'leafTotal',count(*) FILTER(WHERE w.status<>'cancelled' AND NOT EXISTS(SELECT 1 FROM ertad.work_items c WHERE c.organization_id=org AND c.parent_id=w.id AND c.status<>'cancelled' AND ertad.work_visible(actor,c))),
  'leafCompleted',count(*) FILTER(WHERE w.status='completed' AND NOT EXISTS(SELECT 1 FROM ertad.work_items c WHERE c.organization_id=org AND c.parent_id=w.id AND c.status<>'cancelled' AND ertad.work_visible(actor,c)))
 ) FROM visible w;
$$;

CREATE FUNCTION ertad.work_tracking_detail(actor uuid,w ertad.work_items) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('canReport',ertad.work_contributor(actor,w),'overview',ertad.work_overview(actor,w.organization_id,w.id),
  'canSetCriteria',ertad.work_manager(actor,w) AND w.status='open'
    AND NOT EXISTS(SELECT 1 FROM ertad.work_criteria WHERE organization_id=w.organization_id AND work_id=w.id AND submitted_by IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM ertad.work_assignments WHERE organization_id=w.organization_id AND work_id=w.id)
    AND NOT EXISTS(SELECT 1 FROM ertad.work_items WHERE organization_id=w.organization_id AND parent_id=w.id AND status<>'cancelled'),
  'coordinators',CASE WHEN ertad.work_manager(actor,w) THEN COALESCE((SELECT jsonb_agg(c.id ORDER BY c.id) FROM
    (SELECT u.id FROM ertad.member_users u WHERE ertad.work_manager(u.id,w) AND (u.id=actor OR ertad.work_local_manager(u.id,w)) ORDER BY u.id LIMIT 100) c),'[]') ELSE '[]'::jsonb END,
  'criteria',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id,'title',c.title,'weight',c.weight,'status',c.status,
    'submittedBy',c.submitted_by,'verifiedBy',c.verified_by,'submissionNote',c.submission_note,'reviewNote',c.review_note) ORDER BY c.id)
    FROM ertad.work_criteria c WHERE c.organization_id=w.organization_id AND c.work_id=w.id),'[]'),
  'blockerRecords',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',b.id,'kind',b.kind,'reason',b.reason,'ownerId',b.owner_id,
    'ownerActive',ertad.work_manager(b.owner_id,w),'nextReviewAt',b.next_review_at,'nextAction',b.next_action,'resolvedAt',b.resolved_at,'resolution',b.resolution) ORDER BY b.resolved_at NULLS FIRST,b.created_at DESC,b.id)
    FROM (SELECT * FROM ertad.work_blockers WHERE organization_id=w.organization_id AND work_id=w.id ORDER BY resolved_at NULLS FIRST,created_at DESC,id LIMIT 50) b),'[]'));
$$;

CREATE FUNCTION ertad.work_tracking_change(actor uuid,w ertad.work_items,op text,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE entry jsonb; c ertad.work_criteria; b ertad.work_blockers; who uuid; note text:=trim(COALESCE(input->>'note',''));
BEGIN
 IF w.status<>'open' THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Open task required'; END IF;
 IF op='coordinator' THEN
  who:=(input->>'memberId')::uuid;
  IF NOT ertad.work_manager(who,w) OR (who<>actor AND NOT ertad.work_local_manager(who,w)) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Scoped coordinator required'; END IF;
  UPDATE ertad.work_items SET coordinator_id=who WHERE organization_id=w.organization_id AND id=w.id;
  RETURN jsonb_build_object('coordinatorId',who,'previousCoordinatorId',w.coordinator_id);
 ELSIF op='criteria' THEN
  IF jsonb_typeof(input->'criteria') IS DISTINCT FROM 'array' OR jsonb_array_length(input->'criteria') NOT BETWEEN 1 AND 10 THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid criteria'; END IF;
  IF EXISTS(SELECT 1 FROM ertad.work_criteria WHERE organization_id=w.organization_id AND work_id=w.id AND submitted_by IS NOT NULL)
   OR EXISTS(SELECT 1 FROM ertad.work_assignments WHERE organization_id=w.organization_id AND work_id=w.id)
   OR EXISTS(SELECT 1 FROM ertad.work_items WHERE organization_id=w.organization_id AND parent_id=w.id AND status<>'cancelled') THEN
   RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Criteria already frozen'; END IF;
  DELETE FROM ertad.work_criteria WHERE organization_id=w.organization_id AND work_id=w.id;
  FOR entry IN SELECT value FROM jsonb_array_elements(input->'criteria') LOOP
   IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR jsonb_typeof(entry->'title') IS DISTINCT FROM 'string'
     OR jsonb_typeof(entry->'weight') IS DISTINCT FROM 'number' OR entry->>'weight' !~ '^[0-9]+$' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid criterion'; END IF;
   INSERT INTO ertad.work_criteria(organization_id,work_id,id,title,weight) VALUES(w.organization_id,w.id,(entry->>'id')::uuid,trim(entry->>'title'),(entry->>'weight')::integer);
  END LOOP;
  RETURN jsonb_build_object('criteria',input->'criteria');
 ELSIF op IN ('criterion_submit','criterion_verify','criterion_return') THEN
  SELECT * INTO c FROM ertad.work_criteria WHERE organization_id=w.organization_id AND work_id=w.id AND id=(input->>'criterionId')::uuid;
  IF NOT FOUND OR (op='criterion_submit' AND c.status<>'pending') OR (op<>'criterion_submit' AND c.status<>'submitted') THEN
   RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Criterion transition unavailable'; END IF;
  IF length(note) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Evidence or review note required'; END IF;
  IF op='criterion_verify' AND (actor=c.submitted_by OR NOT ertad.work_contributor(c.submitted_by,w)) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Independent verification and current contributor required'; END IF;
  UPDATE ertad.work_criteria SET status=CASE op WHEN 'criterion_submit' THEN 'submitted' WHEN 'criterion_verify' THEN 'verified' ELSE 'pending' END,
   submitted_by=CASE WHEN op='criterion_submit' THEN actor ELSE submitted_by END,
   verified_by=CASE WHEN op='criterion_verify' THEN actor ELSE NULL END,
   submission_note=CASE WHEN op='criterion_submit' THEN note ELSE submission_note END,
   review_note=CASE WHEN op='criterion_submit' THEN '' ELSE note END
   WHERE organization_id=w.organization_id AND work_id=w.id AND id=c.id;
  RETURN jsonb_build_object('criterionId',c.id,'title',c.title);
 ELSIF op IN ('block','block_update') THEN
  who:=COALESCE((input->>'memberId')::uuid,w.coordinator_id);
  IF NOT ertad.work_manager(who,w) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Active blocker owner required'; END IF;
  IF length(note) NOT BETWEEN 3 AND 1000 OR (input->>'nextReviewAt') IS NULL OR (input->>'nextReviewAt')::timestamptz<=clock_timestamp()
   OR (input->>'nextReviewAt')::timestamptz>clock_timestamp()+interval '365 days' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Reason and future review date required'; END IF;
  IF op='block_update' THEN
   UPDATE ertad.work_blockers SET owner_id=who,next_review_at=(input->>'nextReviewAt')::timestamptz,next_action=note
    WHERE organization_id=w.organization_id AND work_id=w.id AND id=(input->>'blockerId')::uuid AND resolved_at IS NULL RETURNING * INTO b;
   IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Open blocker required'; END IF;
   RETURN jsonb_build_object('blockerId',b.id,'ownerId',who,'nextReviewAt',b.next_review_at);
  END IF;
  IF (SELECT count(*) FROM ertad.work_blockers WHERE organization_id=w.organization_id AND work_id=w.id AND resolved_at IS NULL)>=10 THEN
   RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Resolve existing blockers first'; END IF;
  INSERT INTO ertad.work_blockers(organization_id,work_id,kind,reason,owner_id,reporter_id,next_review_at)
   VALUES(w.organization_id,w.id,input->>'kind',note,who,actor,(input->>'nextReviewAt')::timestamptz) RETURNING * INTO b;
  RETURN jsonb_build_object('blockerId',b.id,'kind',b.kind,'ownerId',who,'nextReviewAt',b.next_review_at);
 ELSIF op='resolve_block' THEN
  IF length(note) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Resolution required'; END IF;
  UPDATE ertad.work_blockers SET resolved_by=actor,resolved_at=clock_timestamp(),resolution=note
   WHERE organization_id=w.organization_id AND work_id=w.id AND id=(input->>'blockerId')::uuid AND resolved_at IS NULL RETURNING * INTO b;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Blocker already resolved or unavailable'; END IF;
  RETURN jsonb_build_object('blockerId',b.id,'kind',b.kind);
 END IF;
 RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid tracking operation';
END $$;

CREATE OR REPLACE FUNCTION ertad.work_view(actor uuid,w ertad.work_items) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',w.id,'unitId',w.unit_id,'parentId',w.parent_id,'title',w.title,'description',w.description,
 'unitName',(SELECT name FROM ertad.units WHERE organization_id=w.organization_id AND id=w.unit_id),
 'roleLabel',w.role_label,'priority',w.priority,'capacity',w.capacity,'used',ertad.work_used(w),'deadline',w.deadline,
 'status',w.status,'version',w.version,'actorId',actor,
 'canManage',ertad.review_has_scope(actor,w.organization_id,w.unit_id,'workitem.create'),
 'canVerify',ertad.review_has_scope(actor,w.organization_id,w.unit_id,'workitem.verify'),
 'canParticipate',ertad.review_has_scope(actor,w.organization_id,w.unit_id,'workitem.participate'),
 'verified',(SELECT count(*) FROM ertad.work_assignments WHERE organization_id=w.organization_id AND work_id=w.id AND status='verified'),
 'unread',(SELECT count(*) FROM ertad.work_notifications WHERE organization_id=w.organization_id AND work_id=w.id AND recipient_id=actor AND read_at IS NULL))||ertad.work_tracking(w);
$$;

CREATE OR REPLACE FUNCTION ertad.work_authorize(actor uuid,org uuid,op text,input jsonb) RETURNS uuid
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
 WHEN op IN ('verify','return','criterion_verify','criterion_return') THEN 'workitem.verify' WHEN op IN ('detail','ack','criterion_submit','block') THEN 'workitem.read' ELSE 'workitem.create' END;
 IF NOT ertad.review_has_scope(actor,org,target,'workitem.read') OR NOT ertad.review_has_scope(actor,org,target,permission) THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 IF op IN ('assign','reserve','verify','return') AND (NOT ertad.review_has_scope((input->>'memberId')::uuid,org,target,'workitem.participate')
  OR NOT ertad.review_has_scope((input->>'memberId')::uuid,org,target,'workitem.read')) THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Participant no longer eligible'; END IF;
 IF op IN ('criterion_submit','block') AND NOT ertad.work_contributor(actor,w) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Active contributor required'; END IF;
 IF op IN ('coordinator','block','block_update') AND input->>'memberId' IS NOT NULL AND (NOT ertad.work_manager((input->>'memberId')::uuid,w) OR ((input->>'memberId')::uuid<>actor AND NOT ertad.work_local_manager((input->>'memberId')::uuid,w))) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Scoped manager required'; END IF;
 IF op='criterion_verify' AND EXISTS(SELECT 1 FROM ertad.work_criteria c WHERE c.organization_id=org AND c.work_id=w.id AND c.id=(input->>'criterionId')::uuid AND (c.submitted_by=actor OR NOT ertad.work_contributor(c.submitted_by,w))) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Independent current contributor required'; END IF;
 RETURN target;
END $$;

CREATE OR REPLACE FUNCTION ertad.work_command(sid uuid,token text,op text,org uuid,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_column
DECLARE actor uuid; w ertad.work_items; child ertad.work_items; a ertad.work_assignments; receipt ertad.work_commands;
 result jsonb; mutation boolean; changed boolean:=false; target uuid; subject uuid; note text; n integer; next_status text; event_details jsonb:='{}';
BEGIN
 IF op NOT IN ('contexts','units','list','detail','create','delegate','accept','decline','cancel','complete','apply','reserve','assign','reject','withdraw','start','progress','submit','return','verify','no_show','ack','overview','coordinator','criteria','criterion_submit','criterion_verify','criterion_return','block','block_update','resolve_block') THEN
  RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid operation'; END IF;
 mutation:=op NOT IN ('contexts','units','list','detail','overview');
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
 ELSIF op='overview' THEN
  target:=(input->>'unitId')::uuid;
  IF target IS NOT NULL AND NOT ertad.review_has_scope(actor,org,target,'workitem.read') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
  result:=ertad.work_overview(actor,org,NULL,target);
 ELSIF op='list' THEN
  n:=COALESCE((input->>'page')::integer,1);
  IF n NOT BETWEEN 1 AND 1000 OR COALESCE(input->>'view','open') NOT IN ('open','offered','completed','cancelled','mine','inbox','blocked','overdue','needs_review') OR length(COALESCE(input->>'search',''))>80 THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid filter'; END IF;
  target:=(input->>'unitId')::uuid;
  IF target IS NOT NULL AND NOT ertad.review_has_scope(actor,org,target,'workitem.read') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
  WITH visible AS (SELECT w.* FROM ertad.work_items w WHERE w.organization_id=org AND ertad.work_visible(actor,w) AND (target IS NULL OR target=ANY(w.scope_path))
   AND position(lower(COALESCE(input->>'search','')) in lower(w.title))>0
   AND CASE WHEN input->>'view'='mine' THEN EXISTS(SELECT 1 FROM ertad.work_assignments a WHERE a.organization_id=org AND a.work_id=w.id AND a.user_id=actor)
    WHEN input->>'view'='inbox' THEN EXISTS(SELECT 1 FROM ertad.work_notifications nt WHERE nt.organization_id=org AND nt.work_id=w.id AND nt.recipient_id=actor AND nt.read_at IS NULL)
    WHEN input->>'view'='blocked' THEN w.status IN ('offered','open') AND EXISTS(SELECT 1 FROM ertad.work_blockers b WHERE b.organization_id=org AND b.work_id=w.id AND b.resolved_at IS NULL)
    WHEN input->>'view'='overdue' THEN w.status IN ('offered','open') AND w.deadline<=clock_timestamp()
    WHEN input->>'view'='needs_review' THEN w.status='open' AND (ertad.work_tracking(w)->>'pendingReview')::int>0
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
   result:=ertad.work_view(actor,w)||ertad.work_tracking_detail(actor,w)||jsonb_build_object(
    'assignments',COALESCE((SELECT jsonb_agg(jsonb_build_object('memberId',a.user_id,'status',a.status,'progress',a.progress) ORDER BY a.user_id)
     FROM ertad.work_assignments a WHERE a.organization_id=org AND a.work_id=w.id AND (a.user_id=actor OR ertad.review_has_scope(actor,org,target,'workitem.create') OR ertad.review_has_scope(actor,org,target,'workitem.verify'))),'[]'),
    'events',COALESCE((SELECT jsonb_agg(jsonb_build_object('version',e.version,'action',e.action,'at',e.created_at,'note',e.note,'progress',e.progress,'actorId',e.actor_id,'subjectId',e.subject_id,'details',e.details) ORDER BY e.version DESC)
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
     INSERT INTO ertad.work_events(organization_id,work_id,version,actor_id,subject_id,action,note,progress,created_at) VALUES(org,w.id,w.version,actor,NULL,'delegate',note,NULL,clock_timestamp());
    END IF;
    w:=child;
   ELSE
    IF w.status IN ('completed','cancelled') THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Task finished'; END IF;
    IF op IN ('coordinator','criteria','criterion_submit','criterion_verify','criterion_return','block','block_update','resolve_block') THEN
     event_details:=ertad.work_tracking_change(actor,w,op,input);
    ELSIF op IN ('accept','decline') THEN
     IF w.status<>'offered' OR (op='accept' AND (w.deadline<=clock_timestamp() OR COALESCE((input->>'capacity')::integer,0) NOT BETWEEN 1 AND w.capacity)) THEN
      RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Offer unavailable'; END IF;
     UPDATE ertad.work_items SET status=CASE WHEN op='accept' THEN 'open' ELSE 'cancelled' END,
      coordinator_id=CASE WHEN op='accept' THEN actor ELSE coordinator_id END,
      capacity=CASE WHEN op='accept' THEN (input->>'capacity')::integer ELSE capacity END WHERE organization_id=org AND id=w.id;
    ELSIF op IN ('cancel','complete') THEN
     IF EXISTS(SELECT 1 FROM ertad.work_items WHERE organization_id=org AND parent_id=w.id AND status IN ('offered','open')) THEN
      RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Finish children first'; END IF;
     IF op='complete' AND (EXISTS(SELECT 1 FROM ertad.work_blockers WHERE organization_id=org AND work_id=w.id AND resolved_at IS NULL) OR EXISTS(SELECT 1 FROM ertad.work_criteria WHERE organization_id=org AND work_id=w.id AND status<>'verified')) THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Resolve blockers and verify criteria first'; END IF;
     IF op='complete' AND (w.status<>'open' OR EXISTS(SELECT 1 FROM ertad.work_assignments WHERE organization_id=org AND work_id=w.id AND status IN ('assigned','in_progress','submitted'))
      OR NOT (EXISTS(SELECT 1 FROM ertad.work_assignments WHERE organization_id=org AND work_id=w.id AND status='verified')
        OR EXISTS(SELECT 1 FROM ertad.work_items WHERE organization_id=org AND parent_id=w.id AND status='completed')
        OR EXISTS(SELECT 1 FROM ertad.work_criteria WHERE organization_id=org AND work_id=w.id AND status='verified'))) THEN
      RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Verified completion required'; END IF;
     -- Cancellation cannot release capacity already consumed by verified work.
     IF op='cancel' AND (EXISTS(SELECT 1 FROM ertad.work_criteria WHERE organization_id=org AND work_id=w.id AND status='verified') OR EXISTS(SELECT 1 FROM ertad.work_assignments WHERE organization_id=org AND work_id=w.id AND status='verified')
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
   INSERT INTO ertad.work_events(organization_id,work_id,version,actor_id,subject_id,action,note,progress,created_at,details) VALUES(org,w.id,w.version,actor,subject,op,note,CASE WHEN op='progress' THEN (input->>'progress')::integer END,clock_timestamp(),event_details);
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

CREATE OR REPLACE FUNCTION ertad.work_finish(sid uuid,token text,op text,org uuid,input jsonb,changed boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid; target uuid; w ertad.work_items;
BEGIN
 actor:=ertad.review_identity(sid,token,op<>'ack');
 target:=ertad.work_authorize(actor,org,op,input);
 IF op='delegate' AND (NOT ertad.review_has_scope(actor,org,(input->>'unitId')::uuid,'workitem.create') OR
   NOT ertad.review_has_scope(actor,org,(input->>'unitId')::uuid,'workitem.read')) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 IF changed AND op IN ('block','block_update') THEN
  SELECT * INTO w FROM ertad.work_items WHERE organization_id=org AND id=(input->>'id')::uuid;
  IF NOT ertad.work_manager(COALESCE((input->>'memberId')::uuid,w.coordinator_id),w) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Blocker owner no longer eligible'; END IF;
  IF (input->>'nextReviewAt')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Review deadline passed'; END IF;
 END IF;
 IF changed AND op IN ('create','delegate','accept','apply','assign','reserve') THEN
  IF op IN ('create','delegate') THEN
   IF (input->>'deadline')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Deadline passed'; END IF;
  ELSE
   SELECT * INTO w FROM ertad.work_items WHERE organization_id=org AND id=(input->>'id')::uuid;
   IF w.deadline<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Deadline passed'; END IF;
  END IF;
 END IF;
END $$;

REVOKE ALL ON ertad.work_criteria,ertad.work_blockers FROM PUBLIC,ertad_app;
REVOKE ALL ON FUNCTION ertad.work_default_coordinator(),ertad.work_manager(uuid,ertad.work_items),ertad.work_contributor(uuid,ertad.work_items),ertad.work_tracking(ertad.work_items),ertad.work_overview(uuid,uuid,uuid,uuid),ertad.work_tracking_detail(uuid,ertad.work_items),ertad.work_tracking_change(uuid,ertad.work_items,text,jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION ertad.work_local_manager(uuid,ertad.work_items) FROM PUBLIC;
