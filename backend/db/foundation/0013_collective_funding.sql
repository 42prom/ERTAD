-- Collective administrative review and externally settled funding records.
ALTER TABLE ertad.permission_grants DROP CONSTRAINT permission_grants_permission_check;
ALTER TABLE ertad.permission_grants ADD CONSTRAINT permission_grants_permission_check CHECK
 (permission IN ('unit.read','workitem.create','workitem.verify','workitem.read','workitem.participate',
 'membership.propose','membership.approve','unit.propose','unit.approve','decision.read','decision.manage','decision.publish','decision.vote','qualification.verify',
 'governance.propose','governance.vote','governance.manage','finance.read','finance.record','finance.approve'));
CREATE TABLE ertad.collective_policies (
 organization_id uuid NOT NULL,unit_id uuid NOT NULL,version integer NOT NULL,
 method text NOT NULL CHECK(method IN ('fixed','majority','supermajority','unanimous')),minimum integer NOT NULL CHECK(minimum BETWEEN 1 AND 20),
 PRIMARY KEY(organization_id,unit_id,version),FOREIGN KEY(organization_id,unit_id) REFERENCES ertad.units(organization_id,id)
);
CREATE TABLE ertad.collective_proposals (
 organization_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),unit_id uuid NOT NULL,
 work_id uuid,kind text NOT NULL,parameters jsonb NOT NULL,proposer_id uuid NOT NULL REFERENCES ertad.member_users(id),
 beneficiary_id uuid REFERENCES ertad.member_users(id),reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 1000),
 scope_path uuid[] NOT NULL,eligible_ids uuid[] NOT NULL CHECK(cardinality(eligible_ids) BETWEEN 1 AND 100),threshold integer NOT NULL CHECK(threshold>0),
 policy_version integer NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','withdrawn')),
 version integer NOT NULL DEFAULT 1,deadline timestamptz NOT NULL CHECK(isfinite(deadline)),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,id),FOREIGN KEY(organization_id,unit_id) REFERENCES ertad.units(organization_id,id),
 FOREIGN KEY(organization_id,work_id) REFERENCES ertad.work_items(organization_id,id),CHECK(threshold<=cardinality(eligible_ids))
);
CREATE INDEX collective_queue ON ertad.collective_proposals(organization_id,unit_id,status,created_at,id);
CREATE TABLE ertad.collective_votes (
 organization_id uuid NOT NULL,proposal_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES ertad.member_users(id),
 choice text NOT NULL CHECK(choice IN ('approve','reject')),reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 1000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(organization_id,proposal_id,actor_id),
 FOREIGN KEY(organization_id,proposal_id) REFERENCES ertad.collective_proposals(organization_id,id)
);
CREATE TABLE ertad.collective_receipts (
 organization_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES ertad.member_users(id),key uuid NOT NULL,operation text NOT NULL,
 payload jsonb NOT NULL,response jsonb NOT NULL,PRIMARY KEY(organization_id,actor_id,key)
);
CREATE TABLE ertad.collective_notifications (
 organization_id uuid NOT NULL,proposal_id uuid NOT NULL,recipient_id uuid NOT NULL REFERENCES ertad.member_users(id),read_version integer NOT NULL DEFAULT 0,
 PRIMARY KEY(organization_id,proposal_id,recipient_id),FOREIGN KEY(organization_id,proposal_id) REFERENCES ertad.collective_proposals(organization_id,id)
);
CREATE TABLE ertad.administrative_directives (
 organization_id uuid NOT NULL,proposal_id uuid NOT NULL,unit_id uuid NOT NULL,title text NOT NULL CHECK(length(title) BETWEEN 3 AND 160),body text NOT NULL CHECK(length(body) BETWEEN 3 AND 3000),
 PRIMARY KEY(organization_id,proposal_id),FOREIGN KEY(organization_id,proposal_id) REFERENCES ertad.collective_proposals(organization_id,id),FOREIGN KEY(organization_id,unit_id) REFERENCES ertad.units(organization_id,id)
);
CREATE TABLE ertad.work_funding_targets (
 organization_id uuid NOT NULL,work_id uuid NOT NULL,currency text NOT NULL CHECK(currency IN ('GEL','USD','EUR')),
 goal bigint NOT NULL CHECK(goal BETWEEN 1 AND 99999999999),purpose text NOT NULL CHECK(length(trim(purpose)) BETWEEN 3 AND 500),
 version integer NOT NULL DEFAULT 1,member_snapshot jsonb,published_at timestamptz,published_contributors uuid[] NOT NULL DEFAULT '{}',PRIMARY KEY(organization_id,work_id),FOREIGN KEY(organization_id,work_id) REFERENCES ertad.work_items(organization_id,id)
);
CREATE TABLE ertad.work_funding_envelopes (
 organization_id uuid NOT NULL,target_id uuid NOT NULL,work_id uuid NOT NULL,amount bigint NOT NULL CHECK(amount BETWEEN 1 AND 99999999999),
 PRIMARY KEY(organization_id,work_id),FOREIGN KEY(organization_id,target_id) REFERENCES ertad.work_funding_targets(organization_id,work_id),FOREIGN KEY(organization_id,work_id) REFERENCES ertad.work_items(organization_id,id),CHECK(target_id<>work_id)
);
CREATE TABLE ertad.work_funding_entries (
 organization_id uuid NOT NULL,id uuid NOT NULL,target_id uuid NOT NULL,work_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('receipt','expense','reserve','release','refund','reverse')),
 amount bigint NOT NULL CHECK(amount BETWEEN 1 AND 99999999999),reference_id uuid,external_ref text,
 contributor_id uuid REFERENCES ertad.member_users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,id),FOREIGN KEY(organization_id,id) REFERENCES ertad.collective_proposals(organization_id,id),
 FOREIGN KEY(organization_id,target_id) REFERENCES ertad.work_funding_targets(organization_id,work_id),FOREIGN KEY(organization_id,work_id) REFERENCES ertad.work_items(organization_id,id),
 FOREIGN KEY(organization_id,reference_id) REFERENCES ertad.work_funding_entries(organization_id,id),
 CHECK(external_ref IS NULL OR length(trim(external_ref)) BETWEEN 3 AND 120)
);
CREATE UNIQUE INDEX funding_external_source ON ertad.work_funding_entries(organization_id,external_ref) WHERE kind='receipt';
CREATE INDEX funding_totals ON ertad.work_funding_entries(organization_id,target_id,work_id,kind);
CREATE TABLE ertad.work_funding_pledges (
 organization_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),work_id uuid NOT NULL,user_id uuid NOT NULL REFERENCES ertad.member_users(id),
 amount bigint NOT NULL CHECK(amount BETWEEN 1 AND 99999999999),withdrawn boolean NOT NULL DEFAULT false,
 PRIMARY KEY(organization_id,id),FOREIGN KEY(organization_id,work_id) REFERENCES ertad.work_funding_targets(organization_id,work_id)
);
ALTER TABLE ertad.work_funding_entries ADD COLUMN pledge_id uuid;
ALTER TABLE ertad.work_funding_entries ADD FOREIGN KEY(organization_id,pledge_id) REFERENCES ertad.work_funding_pledges(organization_id,id);

CREATE FUNCTION ertad.collective_permission(kind text,reviewer boolean) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN kind LIKE 'funding_%' THEN CASE WHEN reviewer THEN 'finance.approve' ELSE 'finance.record' END
 WHEN kind='policy' THEN 'governance.manage' WHEN kind='directive' THEN CASE WHEN reviewer THEN 'governance.vote' ELSE 'governance.propose' END END
$$;
CREATE FUNCTION ertad.collective_actor(actor uuid,org uuid,target uuid,kind text,reviewer boolean) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT ertad.review_has_scope(actor,org,target,CASE WHEN reviewer THEN 'governance.vote' ELSE 'governance.propose' END)
 AND ertad.review_has_scope(actor,org,target,ertad.collective_permission(kind,reviewer))
 AND (NOT reviewer OR EXISTS(SELECT 1 FROM ertad.memberships m WHERE m.organization_id=org AND m.user_id=actor AND m.unit_id=target AND m.status='active' AND m.valid_from<=clock_timestamp() AND (m.valid_until IS NULL OR m.valid_until>clock_timestamp())))
$$;
CREATE FUNCTION ertad.collective_visible(actor uuid,p ertad.collective_proposals) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT ertad.unit_path(p.organization_id,p.unit_id)=p.scope_path
 AND (ertad.review_has_scope(actor,p.organization_id,p.unit_id,'governance.propose') OR ertad.review_has_scope(actor,p.organization_id,p.unit_id,'governance.vote'))
 AND (p.kind NOT LIKE 'funding_%' OR ertad.review_has_scope(actor,p.organization_id,p.unit_id,'finance.read'))
$$;
CREATE FUNCTION ertad.collective_yes(p ertad.collective_proposals) RETURNS integer
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT count(*)::int FROM ertad.collective_votes v WHERE v.organization_id=p.organization_id AND v.proposal_id=p.id AND v.choice='approve'
 AND v.actor_id=ANY(p.eligible_ids) AND v.actor_id<>p.proposer_id AND v.actor_id IS DISTINCT FROM p.beneficiary_id
 AND ertad.collective_actor(v.actor_id,p.organization_id,p.unit_id,p.kind,true)
$$;
CREATE FUNCTION ertad.collective_view(actor uuid,p ertad.collective_proposals) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',p.id,'unitId',p.unit_id,'workId',p.work_id,'kind',p.kind,'parameters',p.parameters,'proposerId',p.proposer_id,'reason',p.reason,'version',p.version,
 'status',CASE WHEN p.status='pending' AND p.deadline<=clock_timestamp() THEN 'expired' ELSE p.status END,'deadline',p.deadline,'threshold',p.threshold,'eligibleCount',cardinality(p.eligible_ids),'approvedCount',ertad.collective_yes(p),
 'canVote',p.status='pending' AND p.deadline>clock_timestamp() AND actor=ANY(p.eligible_ids) AND ertad.collective_actor(actor,p.organization_id,p.unit_id,p.kind,true) AND NOT EXISTS(SELECT 1 FROM ertad.collective_votes WHERE organization_id=p.organization_id AND proposal_id=p.id AND actor_id=actor),
 'canWithdraw',actor=p.proposer_id AND p.status='pending',
 'votes',COALESCE((SELECT jsonb_agg(jsonb_build_object('actorId',v.actor_id,'choice',v.choice,'reason',v.reason,'at',v.created_at,'currentlyEligible',ertad.collective_actor(v.actor_id,p.organization_id,p.unit_id,p.kind,true)) ORDER BY v.created_at) FROM ertad.collective_votes v WHERE v.organization_id=p.organization_id AND v.proposal_id=p.id),'[]'))
$$;

CREATE FUNCTION ertad.funding_total(org uuid,target uuid,local_work uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH sums AS (SELECT
 COALESCE(sum(amount) FILTER(WHERE kind='receipt'),0)-COALESCE(sum(amount) FILTER(WHERE kind='refund'),0) collected,
 COALESCE(sum(amount) FILTER(WHERE kind='expense'),0)-COALESCE(sum(amount) FILTER(WHERE kind='reverse'),0) spent,
 COALESCE(sum(amount) FILTER(WHERE kind='reserve'),0)-COALESCE(sum(amount) FILTER(WHERE kind='release' OR (kind='expense' AND reference_id IS NOT NULL)),0) committed
 FROM ertad.work_funding_entries WHERE organization_id=org AND target_id=target AND (local_work IS NULL OR work_id=local_work))
 SELECT jsonb_build_object('collected',collected::text,'spent',spent::text,'committed',committed::text,'available',(collected-spent-committed)::text) FROM sums
$$;
CREATE FUNCTION ertad.funding_target(org uuid,work uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE((SELECT work_id FROM ertad.work_funding_targets WHERE organization_id=org AND work_id=work),(SELECT target_id FROM ertad.work_funding_envelopes WHERE organization_id=org AND work_id=work))
$$;
CREATE FUNCTION ertad.funding_validate(actor uuid,org uuid,unit uuid,work uuid,kind text,data jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE w ertad.work_items; f ertad.work_funding_targets; target uuid; child ertad.work_items;
BEGIN
 SELECT * INTO w FROM ertad.work_items WHERE organization_id=org AND id=work;
 IF NOT FOUND OR w.unit_id<>unit OR NOT ertad.work_visible(actor,w) OR NOT ertad.review_has_scope(actor,org,unit,'finance.read') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Funding scope denied'; END IF;
 IF kind='funding_target' THEN
  IF w.status<>'open' OR ertad.funding_target(org,work) IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ertad.work_funding_targets WHERE organization_id=org AND work_id=work) THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Target unavailable'; END IF;
 ELSE
  target:=ertad.funding_target(org,work);
  SELECT * INTO f FROM ertad.work_funding_targets WHERE organization_id=org AND work_id=target;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Approved target required'; END IF;
  IF kind NOT IN ('funding_refund','funding_release','funding_reverse','funding_publish') AND w.status<>'open' THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Only reconciliation remains on closed tasks'; END IF;
  IF work<>target AND kind IN ('funding_receipt','funding_refund','funding_envelope','funding_publish') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Target owner operation required'; END IF;
 END IF;
 IF kind NOT IN ('funding_publish') AND COALESCE(data->>'amount','') !~ '^[1-9][0-9]{0,10}$' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Positive minor units required'; END IF;
 IF kind='funding_envelope' THEN
  SELECT * INTO child FROM ertad.work_items WHERE organization_id=org AND id=(data->>'childId')::uuid AND parent_id=work;
  IF NOT FOUND OR child.status<>'open' OR NOT ertad.work_visible(actor,child) OR NOT ertad.review_has_scope(actor,org,child.unit_id,'finance.record') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Child allocation authority expired'; END IF;
 END IF;
 IF kind='funding_receipt' AND (NOT ertad.work_visible((data->>'memberId')::uuid,w) OR NOT ertad.review_has_scope((data->>'memberId')::uuid,org,unit,'workitem.participate')) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Current contributor required'; END IF;
END $$;

CREATE FUNCTION ertad.funding_apply(p ertad.collective_proposals) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE f ertad.work_funding_targets; e ertad.work_funding_entries; totals jsonb; local_totals jsonb; target uuid; amount bigint; reserved bigint; spent bigint; used bigint; budget bigint; child ertad.work_items; childid uuid; cohort uuid[]; data jsonb:=p.parameters;
BEGIN
 PERFORM ertad.funding_validate(p.proposer_id,p.organization_id,p.unit_id,p.work_id,p.kind,data);
 amount:=(data->>'amount')::bigint; target:=ertad.funding_target(p.organization_id,p.work_id);
 SELECT * INTO f FROM ertad.work_funding_targets WHERE organization_id=p.organization_id AND work_id=target;
 IF p.kind='funding_target' THEN
  IF target IS NULL THEN
   IF COALESCE((data->>'targetVersion')::int,0)<>0 THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Target version changed'; END IF;
   INSERT INTO ertad.work_funding_targets(organization_id,work_id,currency,goal,purpose) VALUES(p.organization_id,p.work_id,data->>'currency',amount,trim(data->>'purpose'));
  ELSE
   totals:=ertad.funding_total(p.organization_id,target);
   SELECT COALESCE(sum(v.amount-(ertad.funding_total(p.organization_id,target,v.work_id)->>'spent')::bigint-(ertad.funding_total(p.organization_id,target,v.work_id)->>'committed')::bigint),0) INTO reserved FROM ertad.work_funding_envelopes v WHERE v.organization_id=p.organization_id AND v.target_id=target;
   IF amount<(totals->>'spent')::bigint+(totals->>'committed')::bigint+reserved THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Budget cannot discard approved envelopes and commitments'; END IF;
   IF f.version IS DISTINCT FROM (data->>'targetVersion')::int OR data->>'currency'<>f.currency OR amount<(totals->>'spent')::bigint+(totals->>'committed')::bigint OR amount<COALESCE((SELECT sum(v.amount) FROM ertad.work_funding_envelopes v WHERE v.organization_id=p.organization_id AND v.target_id=target),0) THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Budget change conflicts with allocations'; END IF;
   UPDATE ertad.work_funding_targets SET goal=amount,purpose=trim(data->>'purpose'),version=version+1,member_snapshot=NULL WHERE organization_id=p.organization_id AND work_id=target;
  END IF;
  RETURN;
 END IF;
 totals:=ertad.funding_total(p.organization_id,target);
 local_totals:=ertad.funding_total(p.organization_id,target,p.work_id);
 SELECT COALESCE(sum(v.amount - (ertad.funding_total(p.organization_id,target,v.work_id)->>'spent')::bigint - (ertad.funding_total(p.organization_id,target,v.work_id)->>'committed')::bigint),0) INTO reserved FROM ertad.work_funding_envelopes v WHERE v.organization_id=p.organization_id AND v.target_id=target;
 IF p.kind='funding_envelope' THEN
  childid:=(data->>'childId')::uuid;
  SELECT * INTO child FROM ertad.work_items WHERE organization_id=p.organization_id AND id=childid AND parent_id=p.work_id;
  IF NOT FOUND OR child.status<>'open' OR NOT ertad.work_visible(p.proposer_id,child) OR NOT ertad.review_has_scope(p.proposer_id,p.organization_id,child.unit_id,'finance.record') OR EXISTS(SELECT 1 FROM ertad.work_funding_targets WHERE organization_id=p.organization_id AND work_id=childid) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Eligible child allocation required'; END IF;
  SELECT COALESCE(v.amount,0) INTO budget FROM ertad.work_funding_envelopes v WHERE v.organization_id=p.organization_id AND v.work_id=childid;
  budget:=COALESCE(budget,0);
  local_totals:=ertad.funding_total(p.organization_id,target,childid);
  IF amount<(local_totals->>'spent')::bigint+(local_totals->>'committed')::bigint OR amount-budget>(totals->>'available')::bigint-reserved
   OR amount-budget+reserved+(totals->>'spent')::bigint+(totals->>'committed')::bigint>f.goal THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Child budget exceeds available allocation'; END IF;
  INSERT INTO ertad.work_funding_envelopes VALUES(p.organization_id,target,childid,amount) ON CONFLICT(organization_id,work_id) DO UPDATE SET amount=excluded.amount;
  RETURN;
 ELSIF p.kind='funding_publish' THEN
  SELECT COALESCE(array_agg(donor),'{}') INTO cohort FROM (
   SELECT en.contributor_id donor FROM ertad.work_funding_entries en WHERE en.organization_id=p.organization_id AND en.target_id=target AND en.kind='receipt'
   GROUP BY en.contributor_id HAVING sum(en.amount-COALESCE((SELECT sum(r.amount) FROM ertad.work_funding_entries r WHERE r.organization_id=en.organization_id AND r.reference_id=en.id AND r.kind='refund'),0))>0
  ) contributors;
  IF cardinality(cohort)<10 OR (SELECT count(*) FROM unnest(cohort) c WHERE NOT c=ANY(f.published_contributors))<10 OR f.published_at>clock_timestamp()-interval '24 hours' THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Disclosure requires ten new net contributors and a daily interval'; END IF;
  UPDATE ertad.work_funding_targets SET published_at=clock_timestamp(),published_contributors=cohort,member_snapshot=totals||jsonb_build_object('available',((totals->>'available')::bigint-reserved)::text,'envelopeReserved',reserved::text,'goal',f.goal::text,'stillNeeded',greatest(f.goal-(totals->>'collected')::bigint,0)::text,'publishedDate',current_date) WHERE organization_id=p.organization_id AND work_id=target;
  RETURN;
 END IF;
 IF data->>'referenceId' IS NOT NULL THEN
  SELECT * INTO e FROM ertad.work_funding_entries WHERE organization_id=p.organization_id AND id=(data->>'referenceId')::uuid AND target_id=target AND work_id=p.work_id;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Linked record unavailable'; END IF;
  SELECT COALESCE(sum(x.amount),0) INTO used FROM ertad.work_funding_entries x WHERE x.organization_id=p.organization_id AND x.reference_id=e.id;
  IF used+amount>e.amount OR NOT ((p.kind IN ('funding_expense','funding_release') AND e.kind='reserve') OR (p.kind='funding_refund' AND e.kind='receipt') OR (p.kind='funding_reverse' AND e.kind='expense')) THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Correction exceeds original record'; END IF;
 ELSIF p.kind IN ('funding_refund','funding_release','funding_reverse') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Linked record required'; END IF;
 IF p.kind IN ('funding_expense','funding_reserve','funding_refund') AND e.id IS NULL OR p.kind='funding_refund' THEN
  IF p.work_id=target THEN budget:=(totals->>'available')::bigint-reserved;
  ELSE SELECT v.amount INTO budget FROM ertad.work_funding_envelopes v WHERE v.organization_id=p.organization_id AND v.work_id=p.work_id; budget:=budget-(local_totals->>'spent')::bigint-(local_totals->>'committed')::bigint; END IF;
  IF amount>budget OR (p.kind<>'funding_refund' AND amount+(totals->>'spent')::bigint+(totals->>'committed')::bigint>f.goal) THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Insufficient available funding'; END IF;
 END IF;
 IF p.kind='funding_receipt' AND length(trim(COALESCE(data->>'externalRef','')))<3 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='External receipt reference required'; END IF;
 IF p.kind='funding_receipt' AND data->>'pledgeId' IS NOT NULL THEN
  SELECT pl.amount INTO budget FROM ertad.work_funding_pledges pl WHERE pl.organization_id=p.organization_id AND pl.work_id=target AND pl.id=(data->>'pledgeId')::uuid AND pl.user_id=(data->>'memberId')::uuid AND NOT pl.withdrawn;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Contributor pledge unavailable'; END IF;
  SELECT COALESCE(sum(en.amount-COALESCE((SELECT sum(r.amount) FROM ertad.work_funding_entries r WHERE r.organization_id=en.organization_id AND r.reference_id=en.id AND r.kind='refund'),0)),0) INTO used FROM ertad.work_funding_entries en WHERE en.organization_id=p.organization_id AND en.pledge_id=(data->>'pledgeId')::uuid AND en.kind='receipt';
  IF used+amount>budget THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Receipt exceeds remaining pledge'; END IF;
 END IF;
 INSERT INTO ertad.work_funding_entries(organization_id,id,target_id,work_id,kind,amount,reference_id,external_ref,contributor_id,pledge_id)
 VALUES(p.organization_id,p.id,target,p.work_id,substring(p.kind from 9),amount,(data->>'referenceId')::uuid,data->>'externalRef',(data->>'memberId')::uuid,(data->>'pledgeId')::uuid);
END $$;

CREATE FUNCTION ertad.collective_apply(p ertad.collective_proposals) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF p.kind='directive' THEN INSERT INTO ertad.administrative_directives VALUES(p.organization_id,p.id,p.unit_id,trim(p.parameters->>'title'),trim(p.parameters->>'body'));
 ELSIF p.kind='policy' THEN
  IF COALESCE((SELECT max(version) FROM ertad.collective_policies WHERE organization_id=p.organization_id AND unit_id=p.unit_id),0) IS DISTINCT FROM (p.parameters->>'policyVersion')::int THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Policy version changed'; END IF;
  INSERT INTO ertad.collective_policies VALUES(p.organization_id,p.unit_id,(p.parameters->>'policyVersion')::int+1,p.parameters->>'method',(p.parameters->>'minimum')::int);
 ELSIF p.kind IN ('funding_target','funding_receipt','funding_expense','funding_reserve','funding_release','funding_refund','funding_reverse','funding_envelope','funding_publish') THEN PERFORM ertad.funding_apply(p);
 ELSE RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Unsupported collective action'; END IF;
END $$;

CREATE FUNCTION ertad.collective_command(sid uuid,token text,op text,org uuid,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_column
DECLARE actor uuid; p ertad.collective_proposals; policy ertad.collective_policies; receipt ertad.collective_receipts;
 result jsonb; changed boolean:=false; mutation boolean; target uuid; participants uuid[]; threshold integer; kind text; data jsonb; beneficiary uuid; yes integer; n integer;
BEGIN
 IF op NOT IN ('contexts','units','list','detail','propose','vote','withdraw','ack','funding','pledge','withdraw_pledge') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid collective operation'; END IF;
 mutation:=op NOT IN ('contexts','units','list','detail','funding'); actor:=ertad.review_identity(sid,token,mutation AND op<>'ack');
 IF op='contexts' THEN PERFORM 1 FROM ertad.organizations o WHERE EXISTS(SELECT 1 FROM ertad.memberships m WHERE m.organization_id=o.id AND m.user_id=actor) ORDER BY o.id FOR SHARE;
 ELSIF mutation THEN PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR UPDATE;
 ELSE PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR SHARE; END IF;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint); PERFORM ertad.review_identity(sid,token,mutation AND op<>'ack');
 IF op='contexts' THEN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',o.id,'name',o.name)),'[]') INTO result FROM ertad.organizations o WHERE o.status='active' AND EXISTS(SELECT 1 FROM ertad.units u WHERE u.organization_id=o.id AND (ertad.review_has_scope(actor,o.id,u.id,'governance.propose') OR ertad.review_has_scope(actor,o.id,u.id,'governance.vote')));
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
 ELSIF op='funding' THEN result:=ertad.funding_view(actor,org,(input->>'workId')::uuid);
 ELSE
  IF op='propose' THEN
   target:=(input->>'unitId')::uuid; kind:=input->>'kind'; data:=input->'parameters'; beneficiary:=NULL;
   IF kind NOT IN ('policy','directive','funding_target','funding_receipt','funding_expense','funding_reserve','funding_release','funding_refund','funding_reverse','funding_envelope','funding_publish') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Unsupported collective action'; END IF;
   IF NOT ertad.collective_actor(actor,org,target,kind,false) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Proposal authority required'; END IF;
   IF kind LIKE 'funding_%' THEN PERFORM ertad.funding_validate(actor,org,target,(input->>'workId')::uuid,kind,data); END IF;
  ELSIF op IN ('pledge','withdraw_pledge') THEN
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
   IF op IN ('pledge','withdraw_pledge') THEN result:=ertad.funding_pledge(actor,org,op,input);
   ELSIF op='propose' THEN
    IF length(trim(COALESCE(input->>'reason',''))) NOT BETWEEN 3 AND 1000 OR (input->>'deadline')::timestamptz<=clock_timestamp() OR (input->>'deadline')::timestamptz>clock_timestamp()+interval '30 days' OR NOT isfinite((input->>'deadline')::timestamptz) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Reason and bounded deadline required'; END IF;
    SELECT COALESCE(array_agg(u.id ORDER BY u.id),'{}') INTO participants FROM ertad.member_users u WHERE u.id<>actor AND u.id IS DISTINCT FROM beneficiary AND ertad.collective_actor(u.id,org,target,kind,true);
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

CREATE FUNCTION ertad.collective_finish(sid uuid,token text,op text,org uuid,input jsonb,changed boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid; p ertad.collective_proposals; r ertad.collective_receipts;
BEGIN
 actor:=ertad.review_identity(sid,token,op<>'ack');
 IF op IN ('pledge','withdraw_pledge') THEN PERFORM ertad.funding_member_authorize(actor,org,(input->>'workId')::uuid); RETURN; END IF;
 IF op='propose' THEN
  SELECT * INTO r FROM ertad.collective_receipts WHERE organization_id=org AND actor_id=actor AND key=(input->>'key')::uuid;
  SELECT * INTO p FROM ertad.collective_proposals WHERE organization_id=org AND id=(r.response->>'id')::uuid;
  IF NOT ertad.collective_actor(actor,org,p.unit_id,p.kind,false) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Proposer authority expired'; END IF;
 ELSE SELECT * INTO p FROM ertad.collective_proposals WHERE organization_id=org AND id=(input->>'id')::uuid; END IF;
 IF NOT ertad.collective_visible(actor,p) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access expired'; END IF;
 IF changed AND op IN ('vote','propose') AND p.deadline<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Proposal expired during audit'; END IF;
 IF op='vote' AND (NOT actor=ANY(p.eligible_ids) OR NOT ertad.collective_actor(actor,org,p.unit_id,p.kind,true)) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Reviewer authority expired'; END IF;
 IF changed AND p.status='approved' AND (NOT ertad.collective_actor(p.proposer_id,org,p.unit_id,p.kind,false) OR ertad.collective_yes(p)<p.threshold) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Approval authority expired'; END IF;
 IF changed AND p.kind LIKE 'funding_%' THEN PERFORM ertad.funding_validate(p.proposer_id,org,p.unit_id,p.work_id,p.kind,p.parameters); END IF;
END $$;

CREATE FUNCTION ertad.funding_member_authorize(actor uuid,org uuid,work uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE w ertad.work_items;
BEGIN SELECT * INTO w FROM ertad.work_items WHERE organization_id=org AND id=work;
 IF NOT FOUND OR NOT ertad.work_visible(actor,w) OR NOT ertad.review_has_scope(actor,org,w.unit_id,'workitem.participate') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Funding participation denied'; END IF;
END $$;
CREATE FUNCTION ertad.funding_pledge(actor uuid,org uuid,op text,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE new_id uuid;
BEGIN
 IF op='pledge' THEN
  IF COALESCE(input->>'amount','') !~ '^[1-9][0-9]{0,10}$' OR NOT EXISTS(SELECT 1 FROM ertad.work_items WHERE organization_id=org AND id=(input->>'workId')::uuid AND status='open' AND deadline>clock_timestamp()) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Open target and positive amount required'; END IF;
  IF (SELECT count(*) FROM ertad.work_funding_pledges WHERE organization_id=org AND work_id=(input->>'workId')::uuid AND user_id=actor AND NOT withdrawn)>=10 THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Pledge limit'; END IF;
  INSERT INTO ertad.work_funding_pledges(organization_id,work_id,user_id,amount) VALUES(org,(input->>'workId')::uuid,actor,(input->>'amount')::bigint) RETURNING work_funding_pledges.id INTO new_id;
 ELSE
  UPDATE ertad.work_funding_pledges SET withdrawn=true WHERE organization_id=org AND work_id=(input->>'workId')::uuid AND work_funding_pledges.id=(input->>'pledgeId')::uuid AND user_id=actor AND NOT withdrawn RETURNING work_funding_pledges.id INTO new_id;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Own active pledge required'; END IF;
 END IF;
 RETURN jsonb_build_object('id',new_id);
END $$;
CREATE FUNCTION ertad.funding_pledge_received(org uuid,pledge uuid) RETURNS bigint
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(sum(e.amount-COALESCE((SELECT sum(r.amount) FROM ertad.work_funding_entries r WHERE r.organization_id=e.organization_id AND r.reference_id=e.id AND r.kind='refund'),0)),0)::bigint
 FROM ertad.work_funding_entries e WHERE e.organization_id=org AND e.pledge_id=pledge AND e.kind='receipt'
$$;
REVOKE ALL ON FUNCTION ertad.funding_pledge_received(uuid,uuid) FROM PUBLIC;
CREATE FUNCTION ertad.funding_view(actor uuid,org uuid,work uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE w ertad.work_items; f ertad.work_funding_targets; target uuid; child ertad.work_items; reader boolean; totals jsonb; amount bigint; reserved bigint; result jsonb;
BEGIN
 SELECT * INTO w FROM ertad.work_items WHERE organization_id=org AND id=work;
 IF NOT FOUND OR NOT ertad.work_visible(actor,w) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Funding unavailable'; END IF;
 reader:=ertad.review_has_scope(actor,org,w.unit_id,'finance.read'); target:=ertad.funding_target(org,work);
 SELECT * INTO f FROM ertad.work_funding_targets WHERE organization_id=org AND work_id=target;
 result:=jsonb_build_object('actorId',actor,'canRecord',reader AND ertad.collective_actor(actor,org,w.unit_id,'funding_target',false),'canParticipate',ertad.review_has_scope(actor,org,w.unit_id,'workitem.participate'),'canReadRecords',reader,'target',NULL);
 IF NOT FOUND THEN RETURN result; END IF;
 totals:=CASE WHEN work=target THEN ertad.funding_total(org,target) ELSE ertad.funding_total(org,target,work) END;
 IF work<>target THEN SELECT e.amount INTO amount FROM ertad.work_funding_envelopes e WHERE e.organization_id=org AND e.work_id=work;
  totals:=totals||jsonb_build_object('allocated',amount::text,'collected',NULL,'available',(amount-(totals->>'spent')::bigint-(totals->>'committed')::bigint)::text);
 ELSE
  amount:=f.goal;
  SELECT COALESCE(sum(e.amount-(ertad.funding_total(org,target,e.work_id)->>'spent')::bigint-(ertad.funding_total(org,target,e.work_id)->>'committed')::bigint),0) INTO reserved FROM ertad.work_funding_envelopes e WHERE e.organization_id=org AND e.target_id=target;
  totals:=totals||jsonb_build_object('envelopeReserved',reserved::text,'available',((totals->>'available')::bigint-reserved)::text,'stillNeeded',greatest(f.goal-(totals->>'collected')::bigint,0)::text);
 END IF;
 RETURN result||jsonb_build_object('target',jsonb_build_object('currency',f.currency,'goal',amount::text,'purpose',CASE WHEN work=target THEN f.purpose ELSE w.title END,'version',f.version,'isEnvelope',work<>target,
 'totals',CASE WHEN reader THEN totals WHEN work=target THEN f.member_snapshot END,'suppressed',NOT reader AND (work<>target OR f.member_snapshot IS NULL)),
 'entries',CASE WHEN reader THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'kind',e.kind,'amount',e.amount::text,'workId',e.work_id,'referenceId',e.reference_id,'externalRef',e.external_ref,'memberId',e.contributor_id,'pledgeId',e.pledge_id) ORDER BY e.created_at DESC,e.id) FROM (SELECT * FROM ertad.work_funding_entries e WHERE e.organization_id=org AND e.target_id=target AND (work=target OR e.work_id=work) AND EXISTS(SELECT 1 FROM ertad.work_items visible_work WHERE visible_work.organization_id=e.organization_id AND visible_work.id=e.work_id AND ertad.work_visible(actor,visible_work) AND ertad.review_has_scope(actor,org,visible_work.unit_id,'finance.read')) ORDER BY created_at DESC,id LIMIT 100) e),'[]') ELSE '[]'::jsonb END,
 'pledges',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'amount',p.amount::text,'withdrawn',p.withdrawn,'fulfilled',ertad.funding_pledge_received(org,p.id)::text,'remaining',greatest(p.amount-ertad.funding_pledge_received(org,p.id),0)::text)) FROM ertad.work_funding_pledges p WHERE p.organization_id=org AND p.work_id=work AND p.user_id=actor),'[]'));
END $$;

DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['collective_policies','collective_votes','collective_receipts','administrative_directives','work_funding_entries'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON ertad.%I FOR EACH ROW EXECUTE FUNCTION ertad.prevent_audit_log_mutation()',tab);
  EXECUTE format('CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON ertad.%I FOR EACH STATEMENT EXECUTE FUNCTION ertad.prevent_audit_log_mutation()',tab);
 END LOOP;
END $$;
REVOKE ALL ON ertad.collective_policies,ertad.collective_proposals,ertad.collective_votes,ertad.collective_receipts,ertad.collective_notifications,ertad.administrative_directives,ertad.work_funding_targets,ertad.work_funding_envelopes,ertad.work_funding_entries,ertad.work_funding_pledges FROM PUBLIC,ertad_app;
REVOKE ALL ON FUNCTION ertad.collective_permission(text,boolean),ertad.collective_actor(uuid,uuid,uuid,text,boolean),ertad.collective_visible(uuid,ertad.collective_proposals),ertad.collective_yes(ertad.collective_proposals),ertad.collective_view(uuid,ertad.collective_proposals),ertad.funding_total(uuid,uuid,uuid),ertad.funding_target(uuid,uuid),ertad.funding_validate(uuid,uuid,uuid,uuid,text,jsonb),ertad.funding_apply(ertad.collective_proposals),ertad.collective_apply(ertad.collective_proposals),ertad.collective_command(uuid,text,text,uuid,jsonb),ertad.collective_finish(uuid,text,text,uuid,jsonb,boolean),ertad.funding_member_authorize(uuid,uuid,uuid),ertad.funding_pledge(uuid,uuid,text,jsonb),ertad.funding_view(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.collective_command(uuid,text,text,uuid,jsonb),ertad.collective_finish(uuid,text,text,uuid,jsonb,boolean) TO ertad_app;

CREATE FUNCTION ertad.collective_definition_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'Proposal history is immutable'; END IF;
 IF (to_jsonb(NEW)-ARRAY['status','version']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','version']) THEN RAISE EXCEPTION 'Proposal definition is immutable'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ertad.collective_definition_immutable() FROM PUBLIC;
CREATE TRIGGER collective_definition BEFORE UPDATE OR DELETE ON ertad.collective_proposals FOR EACH ROW EXECUTE FUNCTION ertad.collective_definition_immutable();
CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON ertad.collective_proposals FOR EACH STATEMENT EXECUTE FUNCTION ertad.prevent_audit_log_mutation();
