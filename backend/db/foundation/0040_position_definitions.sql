-- Independently reviewed permission definitions; approval never appoints a member.
ALTER TABLE ertad.permission_grants DROP CONSTRAINT permission_grants_permission_check;
ALTER TABLE ertad.permission_grants ADD CONSTRAINT permission_grants_permission_check CHECK(permission IN (
 'unit.read','member.read','workitem.create','workitem.verify','workitem.read','workitem.participate',
 'membership.propose','membership.approve','unit.propose','unit.approve','unit.change.propose','unit.change.approve',
 'decision.read','decision.manage','decision.publish','decision.vote','qualification.verify',
 'governance.propose','governance.vote','governance.manage','finance.read','finance.record','finance.approve',
 'contribution.manage','contribution.award','contribution.read','channel.read','channel.post','channel.manage','channel.moderate',
 'position.propose','position.approve'));
ALTER TABLE ertad.positions ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0);
ALTER TABLE ertad.positions ADD COLUMN predecessor_id uuid;
ALTER TABLE ertad.positions ADD COLUMN version integer NOT NULL DEFAULT 0 CHECK(version>=0);
ALTER TABLE ertad.positions ADD FOREIGN KEY(organization_id,unit_id,predecessor_id) REFERENCES ertad.positions(organization_id,unit_id,id);
CREATE UNIQUE INDEX position_successor_once ON ertad.positions(organization_id,predecessor_id) WHERE predecessor_id IS NOT NULL;
CREATE FUNCTION ertad.position_version() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 NEW.version:=OLD.version;
 IF (to_jsonb(NEW)-'version') IS DISTINCT FROM (to_jsonb(OLD)-'version') THEN NEW.version:=OLD.version+1; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER c_position_version BEFORE UPDATE ON ertad.positions FOR EACH ROW EXECUTE FUNCTION ertad.position_version();

-- The new administrative capabilities are bootstrap-controlled, not self-delegable.
CREATE FUNCTION ertad.position_permissions() RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT ARRAY['unit.read','member.read','workitem.create','workitem.verify','workitem.read','workitem.participate',
 'membership.propose','membership.approve','unit.propose','unit.approve','unit.change.propose','unit.change.approve',
 'decision.read','decision.manage','decision.publish','decision.vote','qualification.verify',
 'governance.propose','governance.vote','governance.manage','finance.read','finance.record','finance.approve',
 'contribution.manage','contribution.award','contribution.read','channel.read','channel.post','channel.manage','channel.moderate']::text[]
$$;
CREATE FUNCTION ertad.position_can_delegate(actor uuid,org uuid,target uuid,permission text,scope text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(permission=ANY(ertad.position_permissions()) AND scope IN ('unit','subtree')
 AND ertad.review_has_scope(actor,org,target,permission)
 AND (scope='unit' OR EXISTS(
 SELECT 1 FROM ertad.memberships m JOIN ertad.positions p ON p.organization_id=m.organization_id AND p.id=m.position_id
 JOIN ertad.permission_bundles b ON b.organization_id=p.organization_id AND b.id=p.bundle_id AND b.version=p.bundle_version
 JOIN ertad.permission_grants g ON g.organization_id=b.organization_id AND g.bundle_id=b.id AND g.bundle_version=b.version
 WHERE m.organization_id=org AND m.user_id=actor AND m.status='active' AND m.valid_from<=clock_timestamp()
 AND (m.valid_until IS NULL OR m.valid_until>clock_timestamp()) AND m.bundle_version=p.bundle_version
 AND p.status='active' AND b.status='approved' AND g.permission=position_can_delegate.permission AND g.scope='subtree'
 AND m.unit_id=ANY(ertad.unit_path(org,target)) AND ertad.unit_path(org,m.unit_id) IS NOT NULL)),false)
$$;
CREATE FUNCTION ertad.position_ceiling(actor uuid,org uuid,target uuid,data jsonb) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_typeof(data->'grants')='array' AND jsonb_array_length(data->'grants') BETWEEN 1 AND 30
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(data->'grants') g
 WHERE NOT ertad.position_can_delegate(actor,org,target,g->>'permission',g->>'scope'))
$$;
ALTER FUNCTION ertad.collective_actor(uuid,uuid,uuid,text,boolean) RENAME TO collective_before_positions_actor;
CREATE FUNCTION ertad.collective_actor(actor uuid,org uuid,target uuid,kind text,reviewer boolean) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN kind IN ('position_create','position_revision') THEN
 ertad.review_has_scope(actor,org,target,'unit.read')
 AND ertad.review_has_scope(actor,org,target,CASE WHEN reviewer THEN 'position.approve' ELSE 'position.propose' END)
 AND ertad.review_has_scope(actor,org,target,CASE WHEN reviewer THEN 'governance.vote' ELSE 'governance.propose' END)
 ELSE ertad.collective_before_positions_actor(actor,org,target,kind,reviewer) END
$$;
ALTER FUNCTION ertad.collective_visible(uuid,ertad.collective_proposals) RENAME TO collective_before_positions_visible;
CREATE FUNCTION ertad.collective_visible(actor uuid,p ertad.collective_proposals) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT ertad.collective_before_positions_visible(actor,p) AND (p.kind NOT IN ('position_create','position_revision')
 OR ertad.collective_actor(actor,p.organization_id,p.unit_id,p.kind,false) OR ertad.collective_actor(actor,p.organization_id,p.unit_id,p.kind,true))
$$;
CREATE OR REPLACE FUNCTION ertad.collective_yes(p ertad.collective_proposals) RETURNS integer
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT count(*)::int FROM ertad.collective_votes v WHERE v.organization_id=p.organization_id AND v.proposal_id=p.id AND v.choice='approve'
 AND v.actor_id=ANY(p.eligible_ids) AND v.actor_id<>p.proposer_id AND v.actor_id IS DISTINCT FROM p.beneficiary_id
 AND ertad.collective_actor(v.actor_id,p.organization_id,p.unit_id,p.kind,true)
 AND (p.kind NOT IN ('position_create','position_revision') OR ertad.position_ceiling(v.actor_id,p.organization_id,p.unit_id,p.parameters))
$$;
CREATE FUNCTION ertad.position_validate(actor uuid,org uuid,target uuid,kind text,data jsonb,applied uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE previous ertad.positions; keys text[];
BEGIN
 IF jsonb_typeof(data) IS DISTINCT FROM 'object' OR jsonb_typeof(data->'grants') IS DISTINCT FROM 'array'
 OR jsonb_typeof(data->'name') IS DISTINCT FROM 'string' OR length(trim(data->>'name')) NOT BETWEEN 1 AND 120 THEN
 RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid position definition'; END IF;
 SELECT array_agg(k) INTO keys FROM jsonb_object_keys(data) k;
 IF NOT (keys <@ (CASE WHEN kind='position_revision' THEN ARRAY['name','grants','sourceId','sourceVersion'] ELSE ARRAY['name','grants'] END))
 OR jsonb_array_length(data->'grants') NOT BETWEEN 1 AND 30
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(data->'grants') g WHERE jsonb_typeof(g)<>'object' OR g-'permission'-'scope'<>'{}'::jsonb
 OR NOT COALESCE(g->>'permission'=ANY(ertad.position_permissions()) AND g->>'scope' IN ('unit','subtree'),false))
 OR (SELECT count(DISTINCT g->>'permission') FROM jsonb_array_elements(data->'grants') g)<>jsonb_array_length(data->'grants')
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(data->'grants') g WHERE g->>'permission'='unit.read') THEN
 RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Explicit unique permissions and unit visibility required'; END IF;
 IF NOT ertad.position_ceiling(actor,org,target,data) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Delegation ceiling exceeded'; END IF;
 IF kind='position_revision' THEN
 SELECT * INTO previous FROM ertad.positions WHERE organization_id=org AND id=(data->>'sourceId')::uuid AND unit_id=target;
 IF NOT FOUND OR previous.status<>'active' OR previous.version IS DISTINCT FROM (data->>'sourceVersion')::integer
 OR EXISTS(SELECT 1 FROM ertad.positions WHERE organization_id=org AND predecessor_id=previous.id AND id IS DISTINCT FROM applied) THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Position version changed'; END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM ertad.positions WHERE organization_id=org AND unit_id=target AND status='active'
 AND lower(trim(name))=lower(trim(data->>'name')) AND id IS DISTINCT FROM applied) THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Position name already in use'; END IF;
END $$;
ALTER FUNCTION ertad.collective_apply(ertad.collective_proposals) RENAME TO collective_before_positions_apply;
CREATE FUNCTION ertad.collective_apply(p ertad.collective_proposals) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE previous ertad.positions;
BEGIN
 IF p.kind NOT IN ('position_create','position_revision') THEN PERFORM ertad.collective_before_positions_apply(p); RETURN; END IF;
 PERFORM ertad.position_validate(p.proposer_id,p.organization_id,p.unit_id,p.kind,p.parameters);
 IF ertad.collective_yes(p)<p.threshold THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Independent delegation authority required'; END IF;
 IF p.kind='position_revision' THEN SELECT * INTO previous FROM ertad.positions WHERE organization_id=p.organization_id AND id=(p.parameters->>'sourceId')::uuid; END IF;
 INSERT INTO ertad.permission_bundles(organization_id,id,version) VALUES(p.organization_id,p.id,1);
 INSERT INTO ertad.permission_grants(organization_id,bundle_id,bundle_version,permission,scope)
 SELECT p.organization_id,p.id,1,g->>'permission',g->>'scope' FROM jsonb_array_elements(p.parameters->'grants') g;
 UPDATE ertad.permission_bundles SET status='approved' WHERE organization_id=p.organization_id AND id=p.id AND version=1;
 INSERT INTO ertad.positions(organization_id,id,unit_id,name,bundle_id,bundle_version,revision,predecessor_id)
 VALUES(p.organization_id,p.id,p.unit_id,trim(p.parameters->>'name'),p.id,1,COALESCE(previous.revision,0)+1,previous.id);
END $$;

CREATE FUNCTION ertad.position_catalogue(actor uuid,org uuid,input jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE result jsonb; target uuid:=(input->>'unitId')::uuid; n integer:=COALESCE((input->>'page')::integer,1);
BEGIN
 IF n NOT BETWEEN 1 AND 1000 OR length(COALESCE(input->>'search',''))>120 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid page'; END IF;
 IF NOT EXISTS(SELECT 1 FROM ertad.units u WHERE u.organization_id=org AND (ertad.collective_actor(actor,org,u.id,'position_create',false) OR ertad.collective_actor(actor,org,u.id,'position_create',true)))
 OR (target IS NOT NULL AND NOT (ertad.collective_actor(actor,org,target,'position_create',false) OR ertad.collective_actor(actor,org,target,'position_create',true))) THEN
 RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Position scope required'; END IF;
 WITH visible AS(SELECT p.* FROM ertad.positions p WHERE p.organization_id=org AND (target IS NULL OR p.unit_id=target)
 AND (ertad.collective_actor(actor,org,p.unit_id,'position_create',false) OR ertad.collective_actor(actor,org,p.unit_id,'position_create',true))
 AND position(lower(COALESCE(input->>'search','')) IN lower(p.name))>0), paged AS(SELECT * FROM visible ORDER BY name,id LIMIT 25 OFFSET (n-1)*25)
 SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'unitId',p.unit_id,'name',p.name,'revision',p.revision,'version',p.version,'status',p.status,'predecessorId',p.predecessor_id,
 'unitName',(SELECT name FROM ertad.units WHERE organization_id=org AND id=p.unit_id),
 'canRevise',p.status='active' AND ertad.collective_actor(actor,org,p.unit_id,'position_revision',false) AND NOT EXISTS(SELECT 1 FROM ertad.positions s WHERE s.organization_id=org AND s.predecessor_id=p.id),
 'grants',(SELECT COALESCE(jsonb_agg(jsonb_build_object('permission',permission,'scope',scope) ORDER BY permission,scope),'[]') FROM ertad.permission_grants WHERE organization_id=org AND bundle_id=p.bundle_id AND bundle_version=p.bundle_version)) ORDER BY p.name,p.id) FROM paged p),'[]'),
 'total',(SELECT count(*) FROM visible),'page',n,
 'units',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',u.id,'name',u.name,'canPropose',ertad.collective_actor(actor,org,u.id,'position_create',false),
 'grants',(SELECT COALESCE(jsonb_agg(jsonb_build_object('permission',permission,'scope',scope) ORDER BY permission,scope),'[]') FROM unnest(ertad.position_permissions()) permission CROSS JOIN unnest(ARRAY['unit','subtree']) scope WHERE ertad.position_can_delegate(actor,org,u.id,permission,scope))) ORDER BY u.name,u.id),'[]') FROM ertad.units u WHERE u.organization_id=org AND (ertad.collective_actor(actor,org,u.id,'position_create',false) OR ertad.collective_actor(actor,org,u.id,'position_create',true)))) INTO result;
 RETURN result;
END $$;

ALTER FUNCTION ertad.collective_finish(uuid,text,text,uuid,jsonb,boolean) RENAME TO collective_before_positions_finish;
CREATE FUNCTION ertad.collective_finish(sid uuid,token text,op text,org uuid,input jsonb,changed boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid; p ertad.collective_proposals; stored ertad.positions; actual jsonb;
BEGIN
 PERFORM ertad.collective_before_positions_finish(sid,token,op,org,input,changed);
 IF NOT changed THEN RETURN; END IF;
 actor:=ertad.review_identity(sid,token,op<>'ack');
 SELECT cp.* INTO p FROM ertad.collective_proposals cp WHERE cp.organization_id=org AND cp.id=CASE WHEN op='propose' THEN
 (SELECT (r.response->>'id')::uuid FROM ertad.collective_receipts r WHERE r.organization_id=org AND r.actor_id=actor AND r.key=(input->>'key')::uuid) ELSE (input->>'id')::uuid END;
 IF p.kind NOT IN ('position_create','position_revision') OR p.kind IS NULL THEN RETURN; END IF;
 IF op IN ('propose','vote') AND p.status NOT IN ('rejected','withdrawn') THEN
 PERFORM ertad.position_validate(p.proposer_id,org,p.unit_id,p.kind,p.parameters,CASE WHEN p.status='approved' THEN p.id END);
 END IF;
 IF p.status='approved' THEN
 SELECT * INTO stored FROM ertad.positions WHERE organization_id=org AND id=p.id;
 SELECT jsonb_agg(jsonb_build_object('permission',permission,'scope',scope) ORDER BY permission) INTO actual FROM ertad.permission_grants WHERE organization_id=org AND bundle_id=p.id AND bundle_version=1;
 IF NOT FOUND OR stored.unit_id IS DISTINCT FROM p.unit_id OR stored.name IS DISTINCT FROM trim(p.parameters->>'name') OR stored.status IS DISTINCT FROM 'active'
 OR stored.bundle_id IS DISTINCT FROM p.id OR stored.bundle_version IS DISTINCT FROM 1 OR stored.version IS DISTINCT FROM 0
 OR stored.predecessor_id IS DISTINCT FROM (p.parameters->>'sourceId')::uuid
 OR actual IS DISTINCT FROM (SELECT jsonb_agg(g ORDER BY g->>'permission') FROM jsonb_array_elements(p.parameters->'grants') g)
 OR NOT EXISTS(SELECT 1 FROM ertad.permission_bundles WHERE organization_id=org AND id=p.id AND version=1 AND status='approved') THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Position changed during audit'; END IF;
 END IF;
END $$;

-- Public entry points retain the existing transactional audit and fresh-session contract.
REVOKE ALL ON FUNCTION ertad.position_permissions(),ertad.position_version(),ertad.position_can_delegate(uuid,uuid,uuid,text,text),ertad.position_ceiling(uuid,uuid,uuid,jsonb),ertad.position_validate(uuid,uuid,uuid,text,jsonb,uuid),ertad.position_catalogue(uuid,uuid,jsonb),
 ertad.collective_before_positions_actor(uuid,uuid,uuid,text,boolean),ertad.collective_before_positions_visible(uuid,ertad.collective_proposals),ertad.collective_before_positions_apply(ertad.collective_proposals),ertad.collective_before_positions_finish(uuid,text,text,uuid,jsonb,boolean),
 ertad.collective_actor(uuid,uuid,uuid,text,boolean),ertad.collective_visible(uuid,ertad.collective_proposals),ertad.collective_apply(ertad.collective_proposals) FROM PUBLIC,ertad_app;
REVOKE ALL ON FUNCTION ertad.collective_finish(uuid,text,text,uuid,jsonb,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.collective_finish(uuid,text,text,uuid,jsonb,boolean) TO ertad_app;

-- Preserve the recognition wrapper; extend its private audited command.
CREATE OR REPLACE FUNCTION ertad.collective_before_recognition_command(sid uuid,token text,op text,org uuid,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_column
DECLARE actor uuid; p ertad.collective_proposals; policy ertad.collective_policies; receipt ertad.collective_receipts;
 result jsonb; changed boolean:=false; mutation boolean; target uuid; participants uuid[]; threshold integer; kind text; data jsonb; beneficiary uuid; yes integer; n integer;
BEGIN
 IF op NOT IN ('contexts','units','list','detail','propose','vote','withdraw','ack','funding','pledge','withdraw_pledge','points','point_contexts','positions','position_contexts') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid collective operation'; END IF;
 mutation:=op NOT IN ('contexts','units','list','detail','funding','points','point_contexts','positions','position_contexts'); actor:=ertad.review_identity(sid,token,mutation AND op<>'ack');
 IF op IN ('contexts','point_contexts','position_contexts') THEN PERFORM 1 FROM ertad.organizations o WHERE EXISTS(SELECT 1 FROM ertad.memberships m WHERE m.organization_id=o.id AND m.user_id=actor) ORDER BY o.id FOR SHARE;
 ELSIF mutation THEN PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR UPDATE;
 ELSE PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR SHARE; END IF;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint); PERFORM ertad.review_identity(sid,token,mutation AND op<>'ack');
 IF op IN ('contexts','point_contexts','position_contexts') THEN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',o.id,'name',o.name)),'[]') INTO result FROM ertad.organizations o WHERE o.status='active' AND EXISTS(SELECT 1 FROM ertad.units u WHERE u.organization_id=o.id AND (CASE WHEN op='position_contexts' THEN ertad.collective_actor(actor,o.id,u.id,'position_create',false) OR ertad.collective_actor(actor,o.id,u.id,'position_create',true) WHEN op='point_contexts' THEN ertad.review_has_scope(actor,o.id,u.id,'unit.read') ELSE ertad.review_has_scope(actor,o.id,u.id,'governance.propose') OR ertad.review_has_scope(actor,o.id,u.id,'governance.vote') END));
 ELSIF op='positions' THEN result:=ertad.position_catalogue(actor,org,input);
 ELSIF op='units' THEN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',u.id,'name',u.name,'canPropose',ertad.review_has_scope(actor,org,u.id,'governance.propose'),'canManage',ertad.review_has_scope(actor,org,u.id,'governance.manage'),
   'policy',COALESCE((SELECT jsonb_build_object('version',c.version,'method',c.method,'minimum',c.minimum) FROM ertad.collective_policies c WHERE c.organization_id=org AND c.unit_id=u.id ORDER BY c.version DESC LIMIT 1),'{"version":0,"method":"fixed","minimum":1}'::jsonb)) ORDER BY u.name,u.id),'[]') INTO result
  FROM ertad.units u WHERE u.organization_id=org AND (ertad.review_has_scope(actor,org,u.id,'governance.propose') OR ertad.review_has_scope(actor,org,u.id,'governance.vote'));
 ELSIF op='list' THEN
  n:=COALESCE((input->>'page')::int,1); IF n NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid page'; END IF;
  WITH visible AS (SELECT p.* FROM ertad.collective_proposals p WHERE p.organization_id=org AND ertad.collective_visible(actor,p) AND (input->>'workId' IS NULL OR p.work_id=(input->>'workId')::uuid)
   AND CASE COALESCE(input->>'view','pending') WHEN 'pending' THEN p.status='pending' AND p.deadline>clock_timestamp()
   WHEN 'mine' THEN p.proposer_id=actor WHEN 'inbox' THEN EXISTS(SELECT 1 FROM ertad.collective_notifications nt WHERE nt.organization_id=org AND nt.proposal_id=p.id AND nt.recipient_id=actor AND nt.read_version<p.version)
   ELSE p.status<>'pending' OR p.deadline<=clock_timestamp() END),paged AS(SELECT * FROM visible ORDER BY created_at DESC,id LIMIT 25 OFFSET (n-1)*25)
  SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(ertad.collective_view(actor,paged::ertad.collective_proposals) ORDER BY created_at DESC,id) FROM paged),'[]'),'total',(SELECT count(*) FROM visible),'page',n) INTO result;
 ELSIF op='points' THEN result:=ertad.contribution_view(actor,org,input);
 ELSIF op='funding' THEN result:=ertad.funding_view(actor,org,(input->>'workId')::uuid);
 ELSE
  IF op='propose' THEN
   target:=(input->>'unitId')::uuid; kind:=input->>'kind'; data:=input->'parameters'; beneficiary:=NULL;
   IF kind NOT IN ('policy','directive','funding_target','funding_receipt','funding_expense','funding_reserve','funding_release','funding_refund','funding_reverse','funding_envelope','funding_publish','points_rule','points_award','points_reverse','position_create','position_revision') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Unsupported collective action'; END IF;
   IF NOT ertad.collective_actor(actor,org,target,kind,false) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Proposal authority required'; END IF;
   IF kind LIKE 'points_%' THEN
    PERFORM ertad.contribution_validate(actor,org,target,kind,data);
    IF kind='points_award' THEN beneficiary:=(data->>'memberId')::uuid;
    ELSIF kind='points_reverse' THEN SELECT user_id INTO beneficiary FROM ertad.contribution_entries WHERE organization_id=org AND id=(data->>'entryId')::uuid; END IF;
   END IF;
   IF kind LIKE 'funding_%' THEN PERFORM ertad.funding_validate(actor,org,target,(input->>'workId')::uuid,kind,data); END IF;
  ELSIF op IN ('pledge','withdraw_pledge','points','point_contexts') THEN
   PERFORM ertad.funding_member_authorize(actor,org,(input->>'workId')::uuid);
  ELSE
   SELECT * INTO p FROM ertad.collective_proposals WHERE organization_id=org AND id=(input->>'id')::uuid;
   IF NOT FOUND OR NOT ertad.collective_visible(actor,p) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Proposal unavailable'; END IF;
   IF op='vote' AND (NOT actor=ANY(p.eligible_ids) OR NOT ertad.collective_actor(actor,org,p.unit_id,p.kind,true)) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Eligible independent voter required'; END IF;
   IF op='withdraw' AND actor<>p.proposer_id THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Own proposal required'; END IF;
  END IF;
  IF op='detail' THEN result:=ertad.collective_view(actor,p);
  ELSIF op='ack' THEN UPDATE ertad.collective_notifications SET read_version=least(p.version,(input->>'version')::int) WHERE organization_id=org AND proposal_id=p.id AND recipient_id=actor AND read_version<(input->>'version')::int; result:=jsonb_build_object('id',p.id);
  ELSE
   SELECT * INTO receipt FROM ertad.collective_receipts WHERE organization_id=org AND actor_id=actor AND key=(input->>'key')::uuid;
   IF FOUND THEN
    IF receipt.operation<>op OR receipt.payload<>input-'key' THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Retry conflict'; END IF;
    RETURN jsonb_build_object('data',receipt.response,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'changed',false));
   END IF;
   IF op IN ('pledge','withdraw_pledge','points','point_contexts') THEN result:=ertad.funding_pledge(actor,org,op,input);
   ELSIF op='propose' THEN
    IF kind IN ('position_create','position_revision') THEN PERFORM ertad.position_validate(actor,org,target,kind,data); END IF;
    IF length(trim(COALESCE(input->>'reason',''))) NOT BETWEEN 3 AND 1000 OR (input->>'deadline')::timestamptz<=clock_timestamp() OR (input->>'deadline')::timestamptz>clock_timestamp()+interval '30 days' OR NOT isfinite((input->>'deadline')::timestamptz) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Reason and bounded deadline required'; END IF;
    SELECT COALESCE(array_agg(u.id ORDER BY u.id),'{}') INTO participants FROM ertad.member_users u WHERE u.id<>actor AND u.id IS DISTINCT FROM beneficiary AND ertad.collective_actor(u.id,org,target,kind,true) AND (kind NOT IN ('position_create','position_revision') OR ertad.position_ceiling(u.id,org,target,data));
    SELECT * INTO policy FROM ertad.collective_policies WHERE organization_id=org AND unit_id=target ORDER BY version DESC LIMIT 1;
    n:=cardinality(participants); threshold:=CASE COALESCE(policy.method,'fixed') WHEN 'majority' THEN n/2+1 WHEN 'supermajority' THEN ceil(n*2.0/3)::int WHEN 'unanimous' THEN n ELSE COALESCE(policy.minimum,1) END;
    IF n<1 OR n>100 OR threshold<1 OR threshold>n THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Insufficient independent reviewers'; END IF;
    INSERT INTO ertad.collective_proposals(organization_id,unit_id,work_id,kind,parameters,proposer_id,beneficiary_id,reason,scope_path,eligible_ids,threshold,policy_version,deadline)
     VALUES(org,target,(input->>'workId')::uuid,kind,data,actor,beneficiary,trim(input->>'reason'),ertad.unit_path(org,target),participants,threshold,COALESCE(policy.version,0),(input->>'deadline')::timestamptz) RETURNING * INTO p;
    INSERT INTO ertad.collective_notifications SELECT org,p.id,u,0 FROM unnest(participants||ARRAY[actor]) u;
    result:=jsonb_build_object('id',p.id,'version',p.version);
   ELSE
    IF p.status<>'pending' OR p.deadline<=clock_timestamp() OR p.version IS DISTINCT FROM (input->>'version')::int THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Proposal state changed'; END IF;
    IF op='withdraw' THEN UPDATE ertad.collective_proposals SET status='withdrawn',version=version+1 WHERE organization_id=org AND id=p.id RETURNING * INTO p;
    ELSIF op='vote' THEN
     IF p.kind IN ('position_create','position_revision') AND NOT ertad.position_ceiling(actor,org,p.unit_id,p.parameters) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Delegation ceiling exceeded'; END IF;
     INSERT INTO ertad.collective_votes VALUES(org,p.id,actor,input->>'choice',trim(input->>'reason'),clock_timestamp());
     yes:=ertad.collective_yes(p);
     IF yes>=p.threshold THEN
      IF NOT ertad.collective_actor(p.proposer_id,org,p.unit_id,p.kind,false) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Proposer authority revoked'; END IF;
      PERFORM ertad.collective_apply(p);
      UPDATE ertad.collective_proposals SET status='approved' WHERE organization_id=org AND id=p.id;
     ELSIF (SELECT count(*) FROM ertad.collective_votes WHERE organization_id=org AND proposal_id=p.id AND choice='reject')>cardinality(p.eligible_ids)-p.threshold THEN UPDATE ertad.collective_proposals SET status='rejected' WHERE organization_id=org AND id=p.id;
     END IF;
     UPDATE ertad.collective_proposals SET version=version+1 WHERE organization_id=org AND id=p.id RETURNING * INTO p;
    END IF;
    result:=jsonb_build_object('id',p.id,'version',p.version);
   END IF;
   changed:=true; INSERT INTO ertad.collective_receipts VALUES(org,actor,(input->>'key')::uuid,op,input-'key',result);
  END IF;
 END IF;
 RETURN jsonb_build_object('data',result,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'proposalId',p.id,'changed',changed));
END $$;

CREATE OR REPLACE FUNCTION ertad.collective_before_recognition_view(actor uuid,p ertad.collective_proposals) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',p.id,'unitId',p.unit_id,'workId',p.work_id,'kind',p.kind,'parameters',p.parameters,'proposerId',p.proposer_id,'reason',p.reason,'version',p.version,
 'status',CASE WHEN p.status='pending' AND p.deadline<=clock_timestamp() THEN 'expired' ELSE p.status END,'deadline',p.deadline,'threshold',p.threshold,'eligibleCount',cardinality(p.eligible_ids),'approvedCount',ertad.collective_yes(p),
 'canVote',p.status='pending' AND p.deadline>clock_timestamp() AND actor=ANY(p.eligible_ids) AND ertad.collective_actor(actor,p.organization_id,p.unit_id,p.kind,true) AND (p.kind NOT IN ('position_create','position_revision') OR ertad.position_ceiling(actor,p.organization_id,p.unit_id,p.parameters)) AND NOT EXISTS(SELECT 1 FROM ertad.collective_votes WHERE organization_id=p.organization_id AND proposal_id=p.id AND actor_id=actor),
 'canWithdraw',actor=p.proposer_id AND p.status='pending',
 'votes',COALESCE((SELECT jsonb_agg(jsonb_build_object('actorId',v.actor_id,'choice',v.choice,'reason',v.reason,'at',v.created_at,'currentlyEligible',ertad.collective_actor(v.actor_id,p.organization_id,p.unit_id,p.kind,true) AND (p.kind NOT IN ('position_create','position_revision') OR ertad.position_ceiling(v.actor_id,p.organization_id,p.unit_id,p.parameters))) ORDER BY v.created_at) FROM ertad.collective_votes v WHERE v.organization_id=p.organization_id AND v.proposal_id=p.id),'[]'))
$$;

