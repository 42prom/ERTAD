-- Retire unused definitions through the existing independent review journey.
-- No memberships, permission bundles or historical records are removed.
CREATE FUNCTION ertad.position_retirement_blocked(org uuid,source uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM ertad.memberships WHERE organization_id=org AND position_id=source
   AND status IN ('active','suspended') AND (valid_until IS NULL OR valid_until>clock_timestamp()))
 OR EXISTS(SELECT 1 FROM ertad.membership_reviews WHERE organization_id=org AND position_id=source
   AND kind IN ('grant','transfer') AND status='pending' AND expires_at>clock_timestamp())
 OR EXISTS(SELECT 1 FROM ertad.collective_proposals WHERE organization_id=org AND kind='position_revision'
   AND parameters->>'sourceId'=source::text AND status='pending' AND deadline>clock_timestamp())
$$;

CREATE FUNCTION ertad.position_retirement_validate(org uuid,target uuid,data jsonb,applied boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE source ertad.positions;
BEGIN
 IF jsonb_typeof(data) IS DISTINCT FROM 'object' OR data-'sourceId'-'sourceVersion'-'sourceName'<>'{}'::jsonb
 OR jsonb_typeof(data->'sourceId') IS DISTINCT FROM 'string'
 OR jsonb_typeof(data->'sourceVersion') IS DISTINCT FROM 'number'
 OR COALESCE(data->>'sourceVersion','') !~ '^[0-9]{1,9}$'
 OR jsonb_typeof(data->'sourceName') IS DISTINCT FROM 'string' THEN
 RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Explicit position reference and version required'; END IF;
 SELECT * INTO source FROM ertad.positions WHERE organization_id=org AND id=(data->>'sourceId')::uuid AND unit_id=target;
 IF NOT FOUND OR source.status IS DISTINCT FROM (CASE WHEN applied THEN 'retired' ELSE 'active' END)
 OR source.version IS DISTINCT FROM ((data->>'sourceVersion')::integer+CASE WHEN applied THEN 1 ELSE 0 END)
 OR source.name IS DISTINCT FROM data->>'sourceName' THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Position version changed'; END IF;
 IF ertad.position_retirement_blocked(org,source.id) THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Position still has memberships or pending changes'; END IF;
END $$;

CREATE OR REPLACE FUNCTION ertad.collective_actor(actor uuid,org uuid,target uuid,kind text,reviewer boolean) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN kind IN ('position_create','position_revision','position_retire') THEN
 ertad.review_has_scope(actor,org,target,'unit.read')
 AND ertad.review_has_scope(actor,org,target,CASE WHEN reviewer THEN 'position.approve' ELSE 'position.propose' END)
 AND ertad.review_has_scope(actor,org,target,CASE WHEN reviewer THEN 'governance.vote' ELSE 'governance.propose' END)
 ELSE ertad.collective_before_positions_actor(actor,org,target,kind,reviewer) END
$$;
CREATE OR REPLACE FUNCTION ertad.collective_visible(actor uuid,p ertad.collective_proposals) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT ertad.collective_before_positions_visible(actor,p) AND (p.kind NOT IN ('position_create','position_revision','position_retire')
 OR ertad.collective_actor(actor,p.organization_id,p.unit_id,p.kind,false) OR ertad.collective_actor(actor,p.organization_id,p.unit_id,p.kind,true))
$$;

ALTER FUNCTION ertad.collective_apply(ertad.collective_proposals) RENAME TO collective_before_retirement_apply;
CREATE FUNCTION ertad.collective_apply(p ertad.collective_proposals) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF p.kind<>'position_retire' THEN PERFORM ertad.collective_before_retirement_apply(p); RETURN; END IF;
 PERFORM ertad.position_retirement_validate(p.organization_id,p.unit_id,p.parameters);
 UPDATE ertad.positions SET status='retired' WHERE organization_id=p.organization_id AND id=(p.parameters->>'sourceId')::uuid;
END $$;

ALTER FUNCTION ertad.position_catalogue(uuid,uuid,jsonb) RENAME TO position_before_retirement_catalogue;
CREATE FUNCTION ertad.position_catalogue(actor uuid,org uuid,input jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE result jsonb;
BEGIN
 result:=ertad.position_before_retirement_catalogue(actor,org,input);
 RETURN result||jsonb_build_object('items',COALESCE((SELECT jsonb_agg(item||jsonb_build_object(
  'canRetire',item->>'status'='active' AND ertad.collective_actor(actor,org,(item->>'unitId')::uuid,'position_retire',false),
  'retirementBlocked',item->>'status'='active' AND ertad.position_retirement_blocked(org,(item->>'id')::uuid)) ORDER BY ordinal)
 FROM jsonb_array_elements(result->'items') WITH ORDINALITY AS entries(item,ordinal)),'[]'::jsonb));
END $$;

ALTER FUNCTION ertad.collective_finish(uuid,text,text,uuid,jsonb,boolean) RENAME TO collective_before_retirement_finish;
CREATE FUNCTION ertad.collective_finish(sid uuid,token text,op text,org uuid,input jsonb,changed boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid; p ertad.collective_proposals;
BEGIN
 PERFORM ertad.collective_before_retirement_finish(sid,token,op,org,input,changed);
 IF NOT changed THEN RETURN; END IF;
 actor:=ertad.review_identity(sid,token,op<>'ack');
 SELECT cp.* INTO p FROM ertad.collective_proposals cp WHERE cp.organization_id=org AND cp.id=CASE WHEN op='propose' THEN
 (SELECT (r.response->>'id')::uuid FROM ertad.collective_receipts r WHERE r.organization_id=org AND r.actor_id=actor AND r.key=(input->>'key')::uuid) ELSE (input->>'id')::uuid END;
 IF p.kind='position_retire' AND (op='propose' OR (op='vote' AND input->>'choice'='approve')) AND p.status NOT IN ('rejected','withdrawn') THEN
 PERFORM ertad.position_retirement_validate(org,p.unit_id,p.parameters,p.status='approved');
 END IF;
END $$;

REVOKE ALL ON FUNCTION ertad.position_retirement_blocked(uuid,uuid),ertad.position_retirement_validate(uuid,uuid,jsonb,boolean),
 ertad.collective_before_retirement_apply(ertad.collective_proposals),ertad.collective_apply(ertad.collective_proposals),
 ertad.position_before_retirement_catalogue(uuid,uuid,jsonb),ertad.position_catalogue(uuid,uuid,jsonb),
 ertad.collective_before_retirement_finish(uuid,text,text,uuid,jsonb,boolean) FROM PUBLIC,ertad_app;
REVOKE ALL ON FUNCTION ertad.collective_finish(uuid,text,text,uuid,jsonb,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.collective_finish(uuid,text,text,uuid,jsonb,boolean) TO ertad_app;


-- Keep the audited command and receipt behavior; add the bounded retirement proposal.
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
   IF kind NOT IN ('policy','directive','funding_target','funding_receipt','funding_expense','funding_reserve','funding_release','funding_refund','funding_reverse','funding_envelope','funding_publish','points_rule','points_award','points_reverse','position_create','position_revision','position_retire') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Unsupported collective action'; END IF;
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
    IF kind='position_retire' THEN PERFORM ertad.position_retirement_validate(org,target,data); END IF;
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

