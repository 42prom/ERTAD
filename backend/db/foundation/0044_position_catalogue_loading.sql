-- Avoid computing the full editor delegation matrix on every catalogue/progress read.
-- The existing authorization and post-audit read checks remain unchanged.
CREATE OR REPLACE FUNCTION ertad.position_before_retirement_catalogue(actor uuid,org uuid,input jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog SET jit=off AS $$
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
 'grants',CASE WHEN COALESCE((input->>'includeGrants')::boolean,true) THEN (SELECT COALESCE(jsonb_agg(jsonb_build_object('permission',permission,'scope',scope) ORDER BY permission,scope),'[]') FROM unnest(ertad.position_permissions()) permission CROSS JOIN unnest(ARRAY['unit','subtree']) scope WHERE ertad.position_can_delegate(actor,org,u.id,permission,scope)) ELSE '[]'::jsonb END) ORDER BY u.name,u.id),'[]') FROM ertad.units u WHERE u.organization_id=org AND (ertad.collective_actor(actor,org,u.id,'position_create',false) OR ertad.collective_actor(actor,org,u.id,'position_create',true)))) INTO result;
 RETURN result;
END $$;

