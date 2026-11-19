-- Shared task instructions, distinct from private completion reports.
CREATE FUNCTION ertad.work_material_links_valid(links jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE item jsonb;
BEGIN
 IF jsonb_typeof(links) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(links)>10 THEN RETURN false; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(links) LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object'
   OR jsonb_typeof(item->'title') IS DISTINCT FROM 'string'
   OR jsonb_typeof(item->'url') IS DISTINCT FROM 'string'
   OR item-'title'-'url'<>'{}'::jsonb
   OR length(trim(item->>'title')) NOT BETWEEN 1 AND 120
   OR length(item->>'url') NOT BETWEEN 8 AND 2048
   OR (item->>'url') !~ '^https?://[^/?#[:space:]@\\]+([/?#][^[:space:]\\]*)?$'
   OR (item->>'url') ~ '[[:cntrl:]]'
   THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
ALTER TABLE ertad.work_items ADD COLUMN material_links jsonb NOT NULL DEFAULT '[]'
 CHECK(ertad.work_material_links_valid(material_links));

ALTER FUNCTION ertad.work_command(uuid,text,text,uuid,jsonb) RENAME TO work_before_materials_command;
CREATE FUNCTION ertad.work_command(sid uuid,token text,op text,org uuid,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb; actor uuid; w ertad.work_items; receipt ertad.work_commands; fingerprint jsonb;
BEGIN
 IF op<>'materials' THEN
  result:=ertad.work_before_materials_command(sid,token,op,org,input);
  IF op='detail' THEN
   SELECT * INTO w FROM ertad.work_items WHERE organization_id=org AND id=(input->>'id')::uuid;
   result:=jsonb_set(result,'{data}',(result->'data')||jsonb_build_object('materialLinks',w.material_links));
  END IF;
  RETURN result;
 END IF;
 actor:=ertad.review_identity(sid,token,true);
 PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint);
 PERFORM ertad.review_identity(sid,token,true);
 PERFORM ertad.work_authorize(actor,org,op,input);
 SELECT * INTO w FROM ertad.work_items WHERE organization_id=org AND id=(input->>'id')::uuid;
 -- The retry receipt retains a digest, not removed URLs or query parameters.
 fingerprint:=jsonb_build_object('sha256',encode(sha256(convert_to((input-'key')::text,'UTF8')),'hex'));
 SELECT * INTO receipt FROM ertad.work_commands WHERE organization_id=org AND actor_id=actor AND key=(input->>'key')::uuid;
 IF FOUND THEN
  IF receipt.operation<>op OR receipt.payload<>fingerprint THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Retry conflict'; END IF;
  RETURN jsonb_build_object('data',receipt.response,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'workId',w.id,'changed',false));
 END IF;
 IF w.version IS DISTINCT FROM (input->>'version')::integer OR w.status NOT IN ('open','offered') THEN
  RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Task changed or closed'; END IF;
 IF NOT ertad.work_material_links_valid(input->'links') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid materials'; END IF;
 UPDATE ertad.work_items SET material_links=input->'links',version=version+1 WHERE organization_id=org AND id=w.id RETURNING * INTO w;
 INSERT INTO ertad.work_events(organization_id,work_id,version,actor_id,action,note,created_at)
  VALUES(org,w.id,w.version,actor,'materials','',clock_timestamp());
 INSERT INTO ertad.work_notifications(organization_id,work_id,version,recipient_id)
  SELECT org,w.id,w.version,u.id FROM ertad.member_users u WHERE u.id<>actor AND u.status='active' AND ertad.work_visible(u.id,w)
  AND (u.id=w.creator_id OR ertad.review_has_scope(u.id,org,w.unit_id,'workitem.create') OR ertad.review_has_scope(u.id,org,w.unit_id,'workitem.verify')
   OR EXISTS(SELECT 1 FROM ertad.work_assignments a WHERE a.organization_id=org AND a.work_id=w.id AND a.user_id=u.id));
 result:=jsonb_build_object('id',w.id,'version',w.version);
 INSERT INTO ertad.work_commands VALUES(org,actor,(input->>'key')::uuid,w.id,op,fingerprint,result);
 RETURN jsonb_build_object('data',result,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'workId',w.id,'changed',true));
END $$;
REVOKE ALL ON FUNCTION ertad.work_material_links_valid(jsonb),ertad.work_before_materials_command(uuid,text,text,uuid,jsonb) FROM PUBLIC,ertad_app;
REVOKE ALL ON FUNCTION ertad.work_command(uuid,text,text,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.work_command(uuid,text,text,uuid,jsonb) TO ertad_app;
