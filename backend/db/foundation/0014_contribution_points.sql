-- Non-monetary recognition. No transfers, money conversion, ranking or authority.
ALTER TABLE ertad.permission_grants DROP CONSTRAINT permission_grants_permission_check;
ALTER TABLE ertad.permission_grants ADD CONSTRAINT permission_grants_permission_check CHECK
 (permission IN ('unit.read','workitem.create','workitem.verify','workitem.read','workitem.participate',
 'membership.propose','membership.approve','unit.propose','unit.approve','decision.read','decision.manage','decision.publish','decision.vote','qualification.verify',
 'governance.propose','governance.vote','governance.manage','finance.read','finance.record','finance.approve','contribution.manage','contribution.award','contribution.read'));
CREATE TABLE ertad.contribution_rules (
 organization_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),unit_id uuid NOT NULL,category text NOT NULL CHECK(category IN ('task','vote','survey','manual')),
 version integer NOT NULL CHECK(version>0),enabled boolean NOT NULL,amount integer NOT NULL CHECK(amount BETWEEN 1 AND 100000),
 member_month_cap integer NOT NULL CHECK(member_month_cap BETWEEN 1 AND 1000000),issuer_month_cap integer NOT NULL CHECK(issuer_month_cap BETWEEN 1 AND 1000000),
 proposal_id uuid NOT NULL,PRIMARY KEY(organization_id,id),UNIQUE(organization_id,category,version),
 FOREIGN KEY(organization_id,unit_id) REFERENCES ertad.units(organization_id,id),FOREIGN KEY(organization_id,proposal_id) REFERENCES ertad.collective_proposals(organization_id,id),CHECK(amount<=member_month_cap AND amount<=issuer_month_cap)
);
CREATE TABLE ertad.contribution_entries (
 organization_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),unit_id uuid NOT NULL,user_id uuid NOT NULL REFERENCES ertad.member_users(id),
 kind text NOT NULL CHECK(kind IN ('award','reversal','cap_reached')),category text NOT NULL CHECK(category IN ('task','vote','survey','manual')),
 points integer NOT NULL,rule_id uuid NOT NULL,source_kind text NOT NULL CHECK(source_kind IN ('activity','decision_participation','manual','reversal')),
 source_id uuid NOT NULL,issuer_id uuid REFERENCES ertad.member_users(id),reverses_id uuid,
 reason text NOT NULL DEFAULT '' CHECK(length(reason)<=1000),earned_on date NOT NULL DEFAULT current_date,
 PRIMARY KEY(organization_id,id),FOREIGN KEY(organization_id,unit_id) REFERENCES ertad.units(organization_id,id),
 FOREIGN KEY(organization_id,rule_id) REFERENCES ertad.contribution_rules(organization_id,id),FOREIGN KEY(organization_id,reverses_id) REFERENCES ertad.contribution_entries(organization_id,id),
 CHECK((kind='award' AND points>0 AND reverses_id IS NULL) OR (kind='cap_reached' AND points=0 AND reverses_id IS NULL) OR (kind='reversal' AND points<0 AND reverses_id IS NOT NULL)),
 CHECK(issuer_id IS NULL OR issuer_id<>user_id)
);
CREATE UNIQUE INDEX contribution_source_once ON ertad.contribution_entries(organization_id,user_id,source_kind,source_id) WHERE kind<>'reversal';
CREATE UNIQUE INDEX contribution_reverse_once ON ertad.contribution_entries(organization_id,reverses_id) WHERE reverses_id IS NOT NULL;
CREATE INDEX contribution_private_history ON ertad.contribution_entries(organization_id,user_id,earned_on,id);
ALTER TABLE ertad.work_items ADD COLUMN contribution_rule_id uuid;
ALTER TABLE ertad.work_items ADD FOREIGN KEY(organization_id,contribution_rule_id) REFERENCES ertad.contribution_rules(organization_id,id);
ALTER TABLE ertad.decisions ADD COLUMN contribution_rule_id uuid;
ALTER TABLE ertad.decisions ADD FOREIGN KEY(organization_id,contribution_rule_id) REFERENCES ertad.contribution_rules(organization_id,id);

CREATE FUNCTION ertad.contribution_current(org uuid,reward_category text) RETURNS uuid
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT r.id FROM (SELECT * FROM ertad.contribution_rules WHERE organization_id=org AND category=reward_category ORDER BY version DESC LIMIT 1) r WHERE r.enabled
$$;
CREATE FUNCTION ertad.contribution_pin() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_TABLE_NAME='work_items' THEN NEW.contribution_rule_id:=ertad.contribution_current(NEW.organization_id,'task');
 ELSIF OLD.status='draft' AND NEW.status='open' THEN NEW.contribution_rule_id:=ertad.contribution_current(NEW.organization_id,CASE WHEN NEW.kind='survey' THEN 'survey' ELSE 'vote' END);
 ELSE NEW.contribution_rule_id:=OLD.contribution_rule_id; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER work_contribution_pin BEFORE INSERT ON ertad.work_items FOR EACH ROW EXECUTE FUNCTION ertad.contribution_pin();
CREATE TRIGGER decision_contribution_pin BEFORE UPDATE ON ertad.decisions FOR EACH ROW EXECUTE FUNCTION ertad.contribution_pin();
CREATE FUNCTION ertad.contribution_issue(org uuid,target uuid,member uuid,rule uuid,source_kind text,source uuid,issuer uuid,amount integer,note text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r ertad.contribution_rules; used bigint; value integer; grant_kind text;
BEGIN
 IF rule IS NULL THEN RETURN; END IF;
 SELECT * INTO r FROM ertad.contribution_rules WHERE organization_id=org AND id=rule;
 IF NOT FOUND OR NOT r.enabled THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Reward rule unavailable'; END IF;
 IF EXISTS(SELECT 1 FROM ertad.contribution_entries e WHERE e.organization_id=org AND e.user_id=member AND e.source_kind=contribution_issue.source_kind AND e.source_id=source AND e.kind<>'reversal') THEN RETURN; END IF;
 IF r.category='manual' AND (amount IS NULL OR amount<1 OR amount>r.amount OR issuer=member OR issuer IS NULL) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Manual recognition limit'; END IF;
 value:=CASE WHEN r.category='manual' THEN amount ELSE r.amount END;grant_kind:='award';
 SELECT COALESCE(sum(points),0) INTO used FROM ertad.contribution_entries WHERE organization_id=org AND user_id=member AND category=r.category AND kind='award' AND earned_on>=date_trunc('month',current_date)::date;
 IF used+value>r.member_month_cap THEN
  IF r.category='manual' THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Member recognition allowance exhausted'; END IF;
  value:=0;grant_kind:='cap_reached';
 END IF;
 IF r.category='manual' THEN
  SELECT COALESCE(sum(points),0) INTO used FROM ertad.contribution_entries WHERE organization_id=org AND issuer_id=issuer AND category='manual' AND kind='award' AND earned_on>=date_trunc('month',current_date)::date;
  IF used+value>r.issuer_month_cap THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Issuer recognition allowance exhausted'; END IF;
 END IF;
 INSERT INTO ertad.contribution_entries(organization_id,unit_id,user_id,kind,category,points,rule_id,source_kind,source_id,issuer_id,reason)
 VALUES(org,target,member,grant_kind,r.category,value,rule,source_kind,source,issuer,note);
END $$;
CREATE FUNCTION ertad.contribution_from_activity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE w ertad.work_items;
BEGIN
 SELECT wi.* INTO w FROM ertad.work_items wi JOIN ertad.work_assignments a ON a.organization_id=wi.organization_id AND a.work_id=wi.id WHERE a.organization_id=NEW.organization_id AND a.id=NEW.assignment_id;
 PERFORM ertad.contribution_issue(NEW.organization_id,NEW.unit_id,NEW.user_id,w.contribution_rule_id,'activity',NEW.id,NEW.verifier_id,NULL,'');
 RETURN NEW;
END $$;
CREATE TRIGGER activity_contribution AFTER INSERT ON ertad.activity_entries FOR EACH ROW EXECUTE FUNCTION ertad.contribution_from_activity();
CREATE FUNCTION ertad.contribution_from_decision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE d ertad.decisions;
BEGIN
 SELECT * INTO d FROM ertad.decisions WHERE organization_id=NEW.organization_id AND id=NEW.decision_id;
 IF d.privacy<>'named' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Anonymous participation requires a separate privacy contract'; END IF;
 PERFORM ertad.contribution_issue(d.organization_id,d.unit_id,NEW.user_id,d.contribution_rule_id,'decision_participation',d.id,NULL,NULL,'');
 RETURN NEW;
END $$;
CREATE TRIGGER named_vote_contribution AFTER INSERT ON ertad.decision_named_votes FOR EACH ROW EXECUTE FUNCTION ertad.contribution_from_decision();
CREATE TRIGGER survey_contribution AFTER INSERT ON ertad.decision_survey_responses FOR EACH ROW EXECUTE FUNCTION ertad.contribution_from_decision();
CREATE FUNCTION ertad.contribution_cancel_decision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.status='cancelled' AND OLD.status<>'cancelled' THEN
  INSERT INTO ertad.contribution_entries(organization_id,unit_id,user_id,kind,category,points,rule_id,source_kind,source_id,reverses_id,reason)
  SELECT e.organization_id,e.unit_id,e.user_id,'reversal',e.category,-e.points,e.rule_id,'reversal',NEW.id,e.id,'Cancelled participation event'
  FROM ertad.contribution_entries e WHERE e.organization_id=NEW.organization_id AND e.source_kind='decision_participation' AND e.source_id=NEW.id AND e.kind='award'
   AND NOT EXISTS(SELECT 1 FROM ertad.contribution_entries r WHERE r.organization_id=e.organization_id AND r.reverses_id=e.id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cancelled_decision_contribution AFTER UPDATE ON ertad.decisions FOR EACH ROW EXECUTE FUNCTION ertad.contribution_cancel_decision();

CREATE FUNCTION ertad.contribution_validate(actor uuid,org uuid,unit uuid,kind text,data jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE e ertad.contribution_entries; member uuid;
BEGIN
 IF kind='points_rule' THEN
  IF NOT EXISTS(SELECT 1 FROM ertad.units WHERE organization_id=org AND id=unit AND parent_id IS NULL AND status='active') OR NOT ertad.review_has_scope(actor,org,unit,'contribution.manage') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Organization reward policy authority required'; END IF;
 ELSE
  IF kind='points_reverse' THEN
   SELECT * INTO e FROM ertad.contribution_entries WHERE organization_id=org AND id=(data->>'entryId')::uuid AND unit_id=unit;
   IF NOT FOUND OR e.kind<>'award' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Scoped award required'; END IF;member:=e.user_id;
  ELSE member:=(data->>'memberId')::uuid; END IF;
  IF actor=member OR NOT ertad.review_has_scope(actor,org,unit,'contribution.award') OR NOT ertad.review_has_scope(member,org,unit,'unit.read') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Independent scoped recognition required'; END IF;
 END IF;
END $$;
CREATE FUNCTION ertad.contribution_apply(p ertad.collective_proposals) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r ertad.contribution_rules; e ertad.contribution_entries; version integer;
BEGIN
 PERFORM ertad.contribution_validate(p.proposer_id,p.organization_id,p.unit_id,p.kind,p.parameters);
 IF p.kind='points_rule' THEN
  SELECT COALESCE(max(cr.version),0) INTO version FROM ertad.contribution_rules cr WHERE cr.organization_id=p.organization_id AND cr.category=p.parameters->>'category';
  IF version IS DISTINCT FROM (p.parameters->>'ruleVersion')::int THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Rule version changed'; END IF;
  INSERT INTO ertad.contribution_rules(organization_id,unit_id,category,version,enabled,amount,member_month_cap,issuer_month_cap,proposal_id)
   VALUES(p.organization_id,p.unit_id,p.parameters->>'category',version+1,(p.parameters->>'enabled')::boolean,(p.parameters->>'amount')::int,(p.parameters->>'memberMonthCap')::int,(p.parameters->>'issuerMonthCap')::int,p.id);
 ELSIF p.kind='points_award' THEN
  IF ertad.contribution_current(p.organization_id,'manual') IS DISTINCT FROM (p.parameters->>'ruleId')::uuid THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Manual policy changed'; END IF;
  PERFORM ertad.contribution_issue(p.organization_id,p.unit_id,(p.parameters->>'memberId')::uuid,(p.parameters->>'ruleId')::uuid,'manual',p.id,p.proposer_id,(p.parameters->>'amount')::int,p.reason);
 ELSE
  SELECT * INTO e FROM ertad.contribution_entries WHERE organization_id=p.organization_id AND id=(p.parameters->>'entryId')::uuid;
  INSERT INTO ertad.contribution_entries(organization_id,unit_id,user_id,kind,category,points,rule_id,source_kind,source_id,issuer_id,reverses_id,reason)
   VALUES(e.organization_id,e.unit_id,e.user_id,'reversal',e.category,-e.points,e.rule_id,'reversal',p.id,p.proposer_id,e.id,p.reason);
 END IF;
END $$;
CREATE FUNCTION ertad.contribution_view(actor uuid,org uuid,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE target uuid:=(input->>'unitId')::uuid; member uuid:=COALESCE((input->>'memberId')::uuid,actor); root uuid; result jsonb; n integer:=COALESCE((input->>'page')::int,1);
BEGIN
 IF NOT EXISTS(SELECT 1 FROM ertad.units u WHERE u.organization_id=org AND ertad.review_has_scope(actor,org,u.id,'unit.read')) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Organization access required'; END IF;
 IF target IS NOT NULL AND NOT ertad.review_has_scope(actor,org,target,'unit.read') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Unit unavailable'; END IF;
 IF member<>actor AND (target IS NULL OR NOT ertad.review_has_scope(actor,org,target,'contribution.read') OR NOT ertad.review_has_scope(member,org,target,'unit.read')) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Private recognition history'; END IF;
 IF n NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid page'; END IF;
 SELECT id INTO root FROM ertad.units WHERE organization_id=org AND parent_id IS NULL AND kind='authority' AND status='active';
 WITH visible AS(SELECT e.* FROM ertad.contribution_entries e WHERE e.organization_id=org AND e.user_id=member AND (member=actor OR (target=ANY(ertad.unit_path(org,e.unit_id)) AND ertad.review_has_scope(actor,org,e.unit_id,'contribution.read')))),
 paged AS(SELECT * FROM visible ORDER BY earned_on DESC,id LIMIT 25 OFFSET (n-1)*25)
 SELECT jsonb_build_object('actorId',actor,'memberId',member,'rootUnitId',root,'canManageRules',ertad.collective_actor(actor,org,root,'points_rule',false),'canAward',target IS NOT NULL AND ertad.collective_actor(actor,org,target,'points_award',false),
 'balance',COALESCE((SELECT sum(points)::text FROM visible),'0'),'total',(SELECT count(*) FROM visible),'page',n,
 'entries',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'kind',kind,'category',category,'points',points,'unitId',unit_id,'reason',reason,'date',earned_on,'reversesId',reverses_id) ORDER BY earned_on DESC,id) FROM paged),'[]'),
 'rules',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'category',category,'version',version,'enabled',enabled,'amount',amount,'memberMonthCap',member_month_cap,'issuerMonthCap',issuer_month_cap) ORDER BY category) FROM (SELECT DISTINCT ON(category) * FROM ertad.contribution_rules WHERE organization_id=org ORDER BY category,version DESC) latest),'[]')) INTO result;
 RETURN result;
END $$;
CREATE FUNCTION ertad.work_reward(w ertad.work_items) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('contributionOffer',(SELECT jsonb_build_object('amount',r.amount,'memberMonthCap',r.member_month_cap,'ruleVersion',r.version) FROM ertad.contribution_rules r WHERE r.organization_id=w.organization_id AND r.id=w.contribution_rule_id))
$$;
DO $$ DECLARE tab text; BEGIN FOREACH tab IN ARRAY ARRAY['contribution_rules','contribution_entries'] LOOP
 EXECUTE format('CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON ertad.%I FOR EACH ROW EXECUTE FUNCTION ertad.prevent_audit_log_mutation()',tab);
 EXECUTE format('CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON ertad.%I FOR EACH STATEMENT EXECUTE FUNCTION ertad.prevent_audit_log_mutation()',tab);
 END LOOP; END $$;
REVOKE ALL ON ertad.contribution_rules,ertad.contribution_entries FROM PUBLIC,ertad_app;
REVOKE ALL ON FUNCTION ertad.contribution_current(uuid,text),ertad.contribution_pin(),ertad.contribution_issue(uuid,uuid,uuid,uuid,text,uuid,uuid,integer,text),ertad.contribution_from_activity(),ertad.contribution_from_decision(),ertad.contribution_cancel_decision(),ertad.contribution_validate(uuid,uuid,uuid,text,jsonb),ertad.contribution_apply(ertad.collective_proposals),ertad.contribution_view(uuid,uuid,jsonb),ertad.work_reward(ertad.work_items) FROM PUBLIC;




-- Collective and task integration.
CREATE OR REPLACE FUNCTION ertad.collective_permission(kind text,reviewer boolean) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN kind LIKE 'funding_%' THEN CASE WHEN reviewer THEN 'finance.approve' ELSE 'finance.record' END
 WHEN kind='points_rule' THEN 'contribution.manage' WHEN kind IN ('points_award','points_reverse') THEN 'contribution.award' WHEN kind='policy' THEN 'governance.manage' WHEN kind='directive' THEN CASE WHEN reviewer THEN 'governance.vote' ELSE 'governance.propose' END END
$$;

CREATE OR REPLACE FUNCTION ertad.collective_visible(actor uuid,p ertad.collective_proposals) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT ertad.unit_path(p.organization_id,p.unit_id)=p.scope_path
 AND (ertad.review_has_scope(actor,p.organization_id,p.unit_id,'governance.propose') OR ertad.review_has_scope(actor,p.organization_id,p.unit_id,'governance.vote'))
 AND (p.kind NOT LIKE 'points_%' OR ertad.review_has_scope(actor,p.organization_id,p.unit_id,'contribution.read'))
 AND (p.kind NOT LIKE 'funding_%' OR ertad.review_has_scope(actor,p.organization_id,p.unit_id,'finance.read'))
$$;

CREATE OR REPLACE FUNCTION ertad.collective_apply(p ertad.collective_proposals) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF p.kind='directive' THEN INSERT INTO ertad.administrative_directives VALUES(p.organization_id,p.id,p.unit_id,trim(p.parameters->>'title'),trim(p.parameters->>'body'));
 ELSIF p.kind='policy' THEN
  IF COALESCE((SELECT max(version) FROM ertad.collective_policies WHERE organization_id=p.organization_id AND unit_id=p.unit_id),0) IS DISTINCT FROM (p.parameters->>'policyVersion')::int THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Policy version changed'; END IF;
  INSERT INTO ertad.collective_policies VALUES(p.organization_id,p.unit_id,(p.parameters->>'policyVersion')::int+1,p.parameters->>'method',(p.parameters->>'minimum')::int);
 ELSIF p.kind IN ('funding_target','funding_receipt','funding_expense','funding_reserve','funding_release','funding_refund','funding_reverse','funding_envelope','funding_publish') THEN PERFORM ertad.funding_apply(p);
 ELSIF p.kind IN ('points_rule','points_award','points_reverse') THEN PERFORM ertad.contribution_apply(p);
 ELSE RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Unsupported collective action'; END IF;
END $$;

CREATE OR REPLACE FUNCTION ertad.collective_command(sid uuid,token text,op text,org uuid,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_column
DECLARE actor uuid; p ertad.collective_proposals; policy ertad.collective_policies; receipt ertad.collective_receipts;
 result jsonb; changed boolean:=false; mutation boolean; target uuid; participants uuid[]; threshold integer; kind text; data jsonb; beneficiary uuid; yes integer; n integer;
BEGIN
 IF op NOT IN ('contexts','units','list','detail','propose','vote','withdraw','ack','funding','pledge','withdraw_pledge','points','point_contexts') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid collective operation'; END IF;
 mutation:=op NOT IN ('contexts','units','list','detail','funding','points','point_contexts'); actor:=ertad.review_identity(sid,token,mutation AND op<>'ack');
 IF op IN ('contexts','point_contexts') THEN PERFORM 1 FROM ertad.organizations o WHERE EXISTS(SELECT 1 FROM ertad.memberships m WHERE m.organization_id=o.id AND m.user_id=actor) ORDER BY o.id FOR SHARE;
 ELSIF mutation THEN PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR UPDATE;
 ELSE PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR SHARE; END IF;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint); PERFORM ertad.review_identity(sid,token,mutation AND op<>'ack');
 IF op IN ('contexts','point_contexts') THEN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',o.id,'name',o.name)),'[]') INTO result FROM ertad.organizations o WHERE o.status='active' AND EXISTS(SELECT 1 FROM ertad.units u WHERE u.organization_id=o.id AND (CASE WHEN op='point_contexts' THEN ertad.review_has_scope(actor,o.id,u.id,'unit.read') ELSE ertad.review_has_scope(actor,o.id,u.id,'governance.propose') OR ertad.review_has_scope(actor,o.id,u.id,'governance.vote') END));
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
   IF kind NOT IN ('policy','directive','funding_target','funding_receipt','funding_expense','funding_reserve','funding_release','funding_refund','funding_reverse','funding_envelope','funding_publish','points_rule','points_award','points_reverse') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Unsupported collective action'; END IF;
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

CREATE OR REPLACE FUNCTION ertad.collective_finish(sid uuid,token text,op text,org uuid,input jsonb,changed boolean) RETURNS void
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
 IF changed AND p.kind LIKE 'points_%' THEN PERFORM ertad.contribution_validate(p.proposer_id,org,p.unit_id,p.kind,p.parameters); END IF;
 IF changed AND p.kind LIKE 'funding_%' THEN PERFORM ertad.funding_validate(p.proposer_id,org,p.unit_id,p.work_id,p.kind,p.parameters); END IF;
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
 'unread',(SELECT count(*) FROM ertad.work_notifications WHERE organization_id=w.organization_id AND work_id=w.id AND recipient_id=actor AND read_at IS NULL))||ertad.work_tracking(w)||ertad.work_reward(w);
$$;

CREATE OR REPLACE FUNCTION ertad.decision_view(actor uuid,d ertad.decisions) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE finished boolean; eligible boolean; voted boolean; total integer; counts jsonb; result jsonb; participation integer; yes_count integer; no_count integer; outcome text;
BEGIN
 finished:=d.status='closed' OR (d.status='open' AND d.closes_at<=clock_timestamp());
 eligible:=EXISTS(SELECT 1 FROM ertad.decision_electorate e WHERE e.organization_id=d.organization_id AND e.decision_id=d.id AND e.user_id=actor
   AND ertad.decision_eligible(actor,d.organization_id,d.unit_id,e.membership_id));
 voted:=EXISTS(SELECT 1 FROM ertad.decision_named_votes v WHERE v.organization_id=d.organization_id AND v.decision_id=d.id AND v.user_id=actor);
 IF d.kind='survey' THEN voted:=EXISTS(SELECT 1 FROM ertad.decision_survey_responses WHERE organization_id=d.organization_id AND decision_id=d.id AND user_id=actor); END IF;
 SELECT count(*) INTO total FROM ertad.decision_electorate WHERE organization_id=d.organization_id AND decision_id=d.id;
 result:=jsonb_build_object('id',d.id,'unitId',d.unit_id,'unitName',(SELECT name FROM ertad.units WHERE organization_id=d.organization_id AND id=d.unit_id),
 'kind',d.kind,'threshold',d.threshold,'questions',d.questions,'title',d.title,'description',d.description,'options',d.options,'privacy',d.privacy,'version',d.version,'quorum',d.quorum,
 'status',CASE WHEN finished THEN 'closed' ELSE d.status END,'closesAt',d.closes_at,'electorate',total,'voted',voted,
 'canManage',ertad.review_has_scope(actor,d.organization_id,d.unit_id,'decision.manage'),
 'canPublish',ertad.review_has_scope(actor,d.organization_id,d.unit_id,'decision.publish'),
 'canVote',eligible AND NOT voted AND d.status='open' AND NOT finished AND d.scope_path=ertad.unit_path(d.organization_id,d.unit_id));
 result:=result||jsonb_build_object('contributionOffer',(SELECT jsonb_build_object('amount',r.amount,'memberMonthCap',r.member_month_cap,'ruleVersion',r.version) FROM ertad.contribution_rules r WHERE r.organization_id=d.organization_id AND r.id=d.contribution_rule_id AND r.enabled));
 IF finished AND d.kind='survey' THEN
  RETURN result||jsonb_build_object('surveyResults',ertad.decision_survey_results(actor,d),'participation',(SELECT count(*) FROM ertad.decision_survey_responses WHERE organization_id=d.organization_id AND decision_id=d.id));
 END IF;
 IF finished THEN
   SELECT jsonb_agg(jsonb_build_object('label',o.label,'votes',(SELECT count(*) FROM ertad.decision_named_votes v
    WHERE v.organization_id=d.organization_id AND v.decision_id=d.id AND v.choice=o.n-1)) ORDER BY o.n)
   INTO counts FROM unnest(d.options) WITH ORDINALITY o(label,n);
   result:=result||jsonb_build_object('results',counts,'participation',(SELECT count(*) FROM ertad.decision_named_votes WHERE organization_id=d.organization_id AND decision_id=d.id));
  IF d.kind='referendum' THEN
   participation:=(result->>'participation')::integer;
   yes_count:=(counts->0->>'votes')::integer; no_count:=(counts->1->>'votes')::integer;
   outcome:=CASE WHEN participation*100<total*d.quorum THEN 'inquorate'
    WHEN yes_count+no_count=0 THEN 'no_decision' WHEN yes_count=no_count THEN 'tie'
    WHEN yes_count>no_count AND yes_count*100 >= (yes_count+no_count)*d.threshold THEN 'accepted' ELSE 'rejected' END;
   result:=result||jsonb_build_object('outcome',outcome);
  END IF;
 END IF;
 RETURN result;
END; $$;
