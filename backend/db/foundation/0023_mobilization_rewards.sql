-- Approved task reward templates reuse the immutable contribution ledger.
ALTER TABLE ertad.contribution_rules ADD COLUMN template_id uuid,
 ADD COLUMN template_title text NOT NULL DEFAULT '' CHECK(length(template_title)<=100),
 ADD COLUMN allowed_unit_id uuid, ADD COLUMN allowed_path uuid[];
ALTER TABLE ertad.contribution_rules ADD FOREIGN KEY(organization_id,allowed_unit_id) REFERENCES ertad.units(organization_id,id);
ALTER TABLE ertad.contribution_rules ADD CHECK(template_id IS NULL OR
 (category='task' AND length(trim(template_title))>=3 AND allowed_unit_id IS NOT NULL AND allowed_path IS NOT NULL AND cardinality(allowed_path)>0));
ALTER TABLE ertad.contribution_rules DROP CONSTRAINT contribution_rules_organization_id_category_version_key;
ALTER TABLE ertad.contribution_rules ADD UNIQUE NULLS NOT DISTINCT(organization_id,category,template_id,version);
ALTER TABLE ertad.work_items ADD COLUMN starts_at timestamptz, ADD COLUMN location text NOT NULL DEFAULT '' CHECK(length(location)<=300);
ALTER TABLE ertad.work_items ADD CHECK(starts_at IS NULL OR starts_at<=deadline);

CREATE OR REPLACE FUNCTION ertad.contribution_current(org uuid,reward_category text) RETURNS uuid
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT r.id FROM (SELECT * FROM ertad.contribution_rules WHERE organization_id=org AND category=reward_category AND template_id IS NULL ORDER BY version DESC LIMIT 1) r WHERE r.enabled
$$;

ALTER FUNCTION ertad.contribution_validate(uuid,uuid,uuid,text,jsonb) RENAME TO contribution_before_templates_validate;
CREATE FUNCTION ertad.contribution_validate(actor uuid,org uuid,unit uuid,kind text,data jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 PERFORM ertad.contribution_before_templates_validate(actor,org,unit,kind,data);
 IF kind='points_rule' AND data ? 'templateId' THEN
  IF data->>'category'<>'task' OR length(trim(COALESCE(data->>'title',''))) NOT BETWEEN 3 AND 100
   OR NOT EXISTS(SELECT 1 FROM ertad.units u WHERE u.organization_id=org AND u.id=(data->>'allowedUnitId')::uuid AND u.status='active' AND u.kind='authority' AND ertad.review_has_scope(actor,org,u.id,'contribution.manage'))
   THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Reward template scope unavailable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM ertad.contribution_rules WHERE organization_id=org AND template_id=(data->>'templateId')::uuid)
   AND (SELECT count(DISTINCT template_id) FROM ertad.contribution_rules WHERE organization_id=org)>=64 THEN
   RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Reward template capacity reached'; END IF;
 ELSIF kind='points_rule' AND (data ? 'title' OR data ? 'allowedUnitId') THEN
  RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Template identifier required';
 END IF;
END $$;

ALTER FUNCTION ertad.contribution_apply(ertad.collective_proposals) RENAME TO contribution_before_templates_apply;
CREATE FUNCTION ertad.contribution_apply(p ertad.collective_proposals) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE v integer; template uuid:=(p.parameters->>'templateId')::uuid; target uuid;
BEGIN
 IF p.kind<>'points_rule' THEN PERFORM ertad.contribution_before_templates_apply(p); RETURN; END IF;
 PERFORM ertad.contribution_validate(p.proposer_id,p.organization_id,p.unit_id,p.kind,p.parameters);
 SELECT COALESCE(max(r.version),0) INTO v FROM ertad.contribution_rules r
  WHERE r.organization_id=p.organization_id AND r.category=p.parameters->>'category' AND r.template_id IS NOT DISTINCT FROM template;
 IF v IS DISTINCT FROM (p.parameters->>'ruleVersion')::int THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Rule version changed'; END IF;
 target:=CASE WHEN template IS NOT NULL THEN (p.parameters->>'allowedUnitId')::uuid END;
 INSERT INTO ertad.contribution_rules(organization_id,unit_id,category,version,enabled,amount,member_month_cap,issuer_month_cap,proposal_id,template_id,template_title,allowed_unit_id,allowed_path)
 VALUES(p.organization_id,p.unit_id,p.parameters->>'category',v+1,(p.parameters->>'enabled')::boolean,(p.parameters->>'amount')::int,
  (p.parameters->>'memberMonthCap')::int,(p.parameters->>'issuerMonthCap')::int,p.id,template,
  CASE WHEN template IS NULL THEN '' ELSE trim(p.parameters->>'title') END,target,CASE WHEN target IS NOT NULL THEN ertad.unit_path(p.organization_id,target) END);
END $$;

CREATE FUNCTION ertad.contribution_template_allowed(actor uuid,r ertad.contribution_rules,target uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT ertad.review_has_scope(actor,r.organization_id,target,'workitem.create') AND ertad.review_has_scope(actor,r.organization_id,target,'workitem.read')
  AND (r.template_id IS NULL OR (r.allowed_path=ertad.unit_path(r.organization_id,r.allowed_unit_id)
   AND r.allowed_unit_id=ANY(ertad.unit_path(r.organization_id,target))))
$$;
CREATE FUNCTION ertad.contribution_rule_choices(actor uuid,org uuid,target uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',r.id,'category',r.category,'version',r.version,'enabled',r.enabled,
 'amount',r.amount,'memberMonthCap',r.member_month_cap,'issuerMonthCap',r.issuer_month_cap,
 'templateId',r.template_id,'title',r.template_title,'allowedUnitId',r.allowed_unit_id) ORDER BY r.category,r.template_title,r.id),'[]')
 FROM (SELECT DISTINCT ON(category,template_id) * FROM ertad.contribution_rules WHERE organization_id=org ORDER BY category,template_id,version DESC) r
 WHERE CASE WHEN target IS NOT NULL THEN r.category='task' AND r.enabled AND ertad.contribution_template_allowed(actor,r,target)
 ELSE r.template_id IS NULL OR ertad.review_has_scope(actor,org,r.unit_id,'contribution.manage') OR EXISTS(
  SELECT 1 FROM ertad.units u WHERE u.organization_id=org AND ertad.contribution_template_allowed(actor,r,u.id)) END
$$;
ALTER FUNCTION ertad.contribution_view(uuid,uuid,jsonb) RENAME TO contribution_before_templates_view;
CREATE FUNCTION ertad.contribution_view(actor uuid,org uuid,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE result jsonb;
BEGIN
 result:=ertad.contribution_before_templates_view(actor,org,input);
 RETURN result||jsonb_build_object('rules',ertad.contribution_rule_choices(actor,org,NULL),
  'entries',COALESCE((SELECT jsonb_agg(item||jsonb_build_object('rewardTitle',r.template_title) ORDER BY ordinal)
  FROM jsonb_array_elements(result->'entries') WITH ORDINALITY AS visible(item,ordinal)
  JOIN ertad.contribution_entries e ON e.organization_id=org AND e.id=(item->>'id')::uuid
  JOIN ertad.contribution_rules r ON r.organization_id=org AND r.id=e.rule_id),'[]'));
END $$;
CREATE OR REPLACE FUNCTION ertad.work_reward(w ertad.work_items) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('startsAt',w.starts_at,'location',w.location,'contributionOffer',
 (SELECT jsonb_build_object('amount',r.amount,'memberMonthCap',r.member_month_cap,'ruleVersion',r.version,'title',r.template_title,'ruleId',r.id)
 FROM ertad.contribution_rules r WHERE r.organization_id=w.organization_id AND r.id=w.contribution_rule_id))
$$;

-- The original command owns scope checks, idempotent receipts and the lifecycle.
-- Additional fields are applied in the same transaction, before audit/final authority checks.
ALTER FUNCTION ertad.work_command(uuid,text,text,uuid,jsonb) RENAME TO work_before_templates_command;
CREATE FUNCTION ertad.work_command(sid uuid,token text,op text,org uuid,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb; actor uuid; w ertad.work_items; parent ertad.work_items; r ertad.contribution_rules; selected uuid; choices jsonb;
BEGIN
 result:=ertad.work_before_templates_command(sid,token,op,org,input);
 actor:=ertad.review_identity(sid,token,op IN ('create','delegate'));
 IF op='units' THEN
  SELECT COALESCE(jsonb_agg(u||jsonb_build_object('rewardOptions',ertad.contribution_rule_choices(actor,org,(u->>'id')::uuid))),'[]') INTO choices FROM jsonb_array_elements(result->'data') u;
  RETURN jsonb_set(result,'{data}',choices);
 END IF;
 IF op NOT IN ('create','delegate') OR NOT (result->'audit'->>'changed')::boolean THEN RETURN result; END IF;
 SELECT * INTO w FROM ertad.work_items WHERE organization_id=org AND id=(result->'data'->>'id')::uuid;
 IF op='delegate' THEN
  SELECT * INTO parent FROM ertad.work_items WHERE organization_id=org AND id=w.parent_id;
  selected:=parent.contribution_rule_id;
  IF input ? 'contributionRuleId' AND (input->>'contributionRuleId')::uuid IS DISTINCT FROM selected THEN
   RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Delegation retains the parent reward'; END IF;
 ELSE
  selected:=CASE WHEN input ? 'contributionRuleId' THEN (input->>'contributionRuleId')::uuid ELSE w.contribution_rule_id END;
  IF selected IS NOT NULL THEN
   SELECT * INTO r FROM ertad.contribution_rules WHERE organization_id=org AND id=selected;
   IF NOT FOUND OR r.category<>'task' OR NOT r.enabled OR NOT ertad.contribution_template_allowed(actor,r,w.unit_id)
    OR EXISTS(SELECT 1 FROM ertad.contribution_rules newer WHERE newer.organization_id=org AND newer.category=r.category AND newer.template_id IS NOT DISTINCT FROM r.template_id AND newer.version>r.version)
    THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Reward offer unavailable'; END IF;
  END IF;
 END IF;
 UPDATE ertad.work_items SET contribution_rule_id=selected,starts_at=(input->>'startsAt')::timestamptz,location=trim(COALESCE(input->>'location','')) WHERE organization_id=org AND id=w.id;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION ertad.work_before_templates_command(uuid,text,text,uuid,jsonb) FROM PUBLIC,ertad_app;
REVOKE ALL ON FUNCTION ertad.work_command(uuid,text,text,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.work_command(uuid,text,text,uuid,jsonb) TO ertad_app;
REVOKE ALL ON FUNCTION ertad.contribution_before_templates_validate(uuid,uuid,uuid,text,jsonb),ertad.contribution_validate(uuid,uuid,uuid,text,jsonb),
 ertad.contribution_before_templates_apply(ertad.collective_proposals),ertad.contribution_apply(ertad.collective_proposals),
 ertad.contribution_template_allowed(uuid,ertad.contribution_rules,uuid),ertad.contribution_rule_choices(uuid,uuid,uuid),
 ertad.contribution_before_templates_view(uuid,uuid,jsonb),ertad.contribution_view(uuid,uuid,jsonb) FROM PUBLIC,ertad_app;
