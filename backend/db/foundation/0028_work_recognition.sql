-- Contextual manual recognition reuses Activity, proposals and the points ledger.
-- No directory, identity disclosure, additional award engine or account grants.
CREATE UNIQUE INDEX contribution_activity_bonus_once ON ertad.collective_proposals
 (organization_id,((parameters->>'activityId')::uuid))
 WHERE kind='points_award' AND status='approved' AND parameters ? 'activityId';

CREATE FUNCTION ertad.recognition_work_access(actor uuid,w ertad.work_items) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT ertad.work_visible(actor,w) AND
 (ertad.review_has_scope(actor,w.organization_id,w.unit_id,'workitem.create') OR
  ertad.review_has_scope(actor,w.organization_id,w.unit_id,'workitem.verify'))
$$;
CREATE FUNCTION ertad.recognition_source(actor uuid,org uuid,activity uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('kind','verified_task','workTitle',CASE WHEN ertad.work_visible(actor,w) THEN w.title END)
 FROM ertad.activity_entries a JOIN ertad.work_assignments wa ON wa.organization_id=a.organization_id AND wa.id=a.assignment_id
 JOIN ertad.work_items w ON w.organization_id=wa.organization_id AND w.id=wa.work_id
 WHERE a.organization_id=org AND a.id=activity
$$;

ALTER FUNCTION ertad.contribution_validate(uuid,uuid,uuid,text,jsonb) RENAME TO contribution_before_recognition_validate;
CREATE FUNCTION ertad.contribution_validate(actor uuid,org uuid,unit uuid,kind text,data jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE a ertad.activity_entries; w ertad.work_items;
BEGIN
 PERFORM ertad.contribution_before_recognition_validate(actor,org,unit,kind,data);
 IF kind='points_award' AND data ? 'activityId' THEN
  SELECT * INTO a FROM ertad.activity_entries WHERE organization_id=org AND id=(data->>'activityId')::uuid;
  IF NOT FOUND OR a.user_id IS DISTINCT FROM (data->>'memberId')::uuid OR a.unit_id<>unit THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Verified contribution unavailable'; END IF;
  SELECT wi.* INTO w FROM ertad.work_items wi JOIN ertad.work_assignments wa ON wa.organization_id=wi.organization_id AND wa.work_id=wi.id
   WHERE wa.organization_id=org AND wa.id=a.assignment_id AND wa.status='verified';
  IF NOT FOUND OR NOT ertad.recognition_work_access(actor,w) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Verified contribution unavailable'; END IF;
  IF ertad.contribution_current(org,'manual') IS DISTINCT FROM (data->>'ruleId')::uuid OR data->>'ruleId' IS NULL THEN
   RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Manual recognition policy changed'; END IF;
  IF NOT EXISTS(SELECT 1 FROM ertad.contribution_rules r WHERE r.organization_id=org AND r.id=(data->>'ruleId')::uuid
   AND (data->>'amount')::integer BETWEEN 1 AND r.amount) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Recognition amount exceeds policy'; END IF;
 END IF;
END $$;

ALTER FUNCTION ertad.collective_command(uuid,text,text,uuid,jsonb) RENAME TO collective_before_recognition_command;
CREATE FUNCTION ertad.collective_command(sid uuid,token text,op text,org uuid,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid; w ertad.work_items; r ertad.contribution_rules; result jsonb; data jsonb; participants jsonb;
BEGIN
 IF op<>'recognition' THEN
  result:=ertad.collective_before_recognition_command(sid,token,op,org,input);
  IF op='propose' AND input->>'kind'='points_award' AND input->'parameters' ? 'activityId' AND (result->'audit'->>'changed')::boolean THEN
   IF EXISTS(SELECT 1 FROM ertad.collective_proposals p WHERE p.organization_id=org AND p.kind='points_award'
    AND (p.parameters->>'activityId')::uuid=(input->'parameters'->>'activityId')::uuid AND p.id<>(result->'data'->>'id')::uuid
    AND (p.status='approved' OR (p.status='pending' AND p.deadline>clock_timestamp()))) THEN
    RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Recognition already proposed or awarded'; END IF;
  END IF;
  RETURN result;
 END IF;
 actor:=ertad.review_identity(sid,token,false);
 PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint);
 PERFORM ertad.review_identity(sid,token,false);
 SELECT * INTO w FROM ertad.work_items WHERE organization_id=org AND id=(input->>'workId')::uuid;
 IF NOT FOUND OR NOT ertad.work_visible(actor,w) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Task unavailable'; END IF;
 IF NOT ertad.recognition_work_access(actor,w) OR NOT ertad.collective_actor(actor,org,w.unit_id,'points_award',false) THEN
  data:=jsonb_build_object('canAward',false,'participants','[]'::jsonb);
 ELSE
  SELECT * INTO r FROM ertad.contribution_rules WHERE organization_id=org AND id=ertad.contribution_current(org,'manual');
  SELECT COALESCE(jsonb_agg(jsonb_build_object('activityId',a.id,'memberId',a.user_id,
   'state',CASE WHEN EXISTS(SELECT 1 FROM ertad.collective_proposals p WHERE p.organization_id=org AND p.kind='points_award' AND (p.parameters->>'activityId')::uuid=a.id AND p.status='approved') THEN 'awarded'
    WHEN EXISTS(SELECT 1 FROM ertad.collective_proposals p WHERE p.organization_id=org AND p.kind='points_award' AND (p.parameters->>'activityId')::uuid=a.id AND p.status='pending' AND p.deadline>clock_timestamp()) THEN 'pending'
    ELSE 'available' END) ORDER BY a.user_id),'[]') INTO participants
  FROM ertad.activity_entries a JOIN ertad.work_assignments wa ON wa.organization_id=a.organization_id AND wa.id=a.assignment_id
  WHERE a.organization_id=org AND wa.work_id=w.id AND wa.status='verified' AND a.user_id<>actor
   AND ertad.review_has_scope(a.user_id,org,w.unit_id,'unit.read');
  data:=jsonb_build_object('canAward',r.id IS NOT NULL,'unitId',w.unit_id,'participants',participants,
   'rule',CASE WHEN r.id IS NOT NULL THEN jsonb_build_object('id',r.id,'amount',r.amount,'memberMonthCap',r.member_month_cap,'issuerMonthCap',r.issuer_month_cap) END);
 END IF;
 RETURN jsonb_build_object('data',data,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'workId',w.id,'changed',false));
END $$;

ALTER FUNCTION ertad.collective_view(uuid,ertad.collective_proposals) RENAME TO collective_before_recognition_view;
CREATE FUNCTION ertad.collective_view(actor uuid,p ertad.collective_proposals) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT ertad.collective_before_recognition_view(actor,p)||jsonb_build_object('recognitionSource',
 CASE WHEN p.kind='points_award' AND p.parameters ? 'activityId' THEN ertad.recognition_source(actor,p.organization_id,(p.parameters->>'activityId')::uuid) END)
$$;
ALTER FUNCTION ertad.contribution_view(uuid,uuid,jsonb) RENAME TO contribution_before_recognition_view;
CREATE FUNCTION ertad.contribution_view(actor uuid,org uuid,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE result jsonb;
BEGIN
 result:=ertad.contribution_before_recognition_view(actor,org,input);
 RETURN result||jsonb_build_object('entries',COALESCE((SELECT jsonb_agg(item||jsonb_build_object('recognitionSource',
  CASE WHEN p.parameters ? 'activityId' THEN ertad.recognition_source(actor,org,(p.parameters->>'activityId')::uuid) END) ORDER BY ordinal)
  FROM jsonb_array_elements(result->'entries') WITH ORDINALITY AS visible(item,ordinal)
  JOIN ertad.contribution_entries e ON e.organization_id=org AND e.id=(item->>'id')::uuid
  LEFT JOIN ertad.contribution_entries original ON original.organization_id=org AND original.id=e.reverses_id
  LEFT JOIN ertad.collective_proposals p ON p.organization_id=org AND p.kind='points_award' AND
   p.id=CASE WHEN e.source_kind='manual' THEN e.source_id WHEN original.source_kind='manual' THEN original.source_id END),'[]'));
END $$;
REVOKE ALL ON FUNCTION ertad.recognition_work_access(uuid,ertad.work_items),ertad.recognition_source(uuid,uuid,uuid),
 ertad.contribution_before_recognition_validate(uuid,uuid,uuid,text,jsonb),ertad.contribution_validate(uuid,uuid,uuid,text,jsonb),
 ertad.collective_before_recognition_command(uuid,text,text,uuid,jsonb),ertad.collective_before_recognition_view(uuid,ertad.collective_proposals),
 ertad.collective_view(uuid,ertad.collective_proposals),ertad.contribution_before_recognition_view(uuid,uuid,jsonb),ertad.contribution_view(uuid,uuid,jsonb) FROM PUBLIC,ertad_app;
REVOKE ALL ON FUNCTION ertad.collective_command(uuid,text,text,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.collective_command(uuid,text,text,uuid,jsonb) TO ertad_app;
