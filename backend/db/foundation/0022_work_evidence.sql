-- Bounded private text reports, independent of completion/verification authority.
CREATE TABLE ertad.work_evidence (
 organization_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),work_id uuid NOT NULL,
 uploader_id uuid NOT NULL REFERENCES ertad.member_users(id),request_key uuid NOT NULL,
 digest text NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'),bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 65536),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready','purged')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '15 minutes',
 PRIMARY KEY(organization_id,id),UNIQUE(organization_id,uploader_id,request_key),
 FOREIGN KEY(organization_id,work_id) REFERENCES ertad.work_items(organization_id,id)
);
CREATE INDEX work_evidence_expiry ON ertad.work_evidence(expires_at) WHERE state<>'purged';
CREATE INDEX work_evidence_task ON ertad.work_evidence(organization_id,work_id,created_at,id);
REVOKE ALL ON ertad.work_evidence FROM PUBLIC,ertad_app;

CREATE FUNCTION ertad.work_evidence_command(sid uuid,token text,op text,org uuid,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid;w ertad.work_items;e ertad.work_evidence;reviewer boolean;can_add boolean;result jsonb;
BEGIN
 IF op NOT IN ('list','reserve','ready','download') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid evidence operation';END IF;
 actor:=ertad.review_identity(sid,token,false);
 PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR SHARE;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint);
 PERFORM ertad.review_identity(sid,token,false);
 SELECT * INTO w FROM ertad.work_items WHERE organization_id=org AND id=(input->>'workId')::uuid;
 IF NOT FOUND OR NOT ertad.work_visible(actor,w) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Evidence unavailable';END IF;
 reviewer:=ertad.work_manager(actor,w) OR ertad.review_has_scope(actor,org,w.unit_id,'workitem.verify');
 IF NOT reviewer AND NOT ertad.work_contributor(actor,w) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Evidence unavailable';END IF;
 can_add:=w.status='open' AND (ertad.work_manager(actor,w) OR EXISTS(
  SELECT 1 FROM ertad.work_assignments WHERE organization_id=org AND work_id=w.id AND user_id=actor AND status IN ('assigned','in_progress')));
 IF op='list' THEN
  SELECT jsonb_build_object('canUpload',can_add,'items',COALESCE(jsonb_agg(jsonb_build_object(
   'id',x.id,'bytes',x.bytes,'createdAt',x.created_at,'expiresAt',x.expires_at,'mine',x.uploader_id=actor)
   ORDER BY x.created_at DESC,x.id),'[]')) INTO result FROM ertad.work_evidence x
   WHERE x.organization_id=org AND x.work_id=w.id AND x.state='ready' AND x.expires_at>clock_timestamp() AND (reviewer OR x.uploader_id=actor);
 ELSIF op='reserve' THEN
  IF NOT can_add THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Active contribution required';END IF;
  SELECT * INTO e FROM ertad.work_evidence WHERE organization_id=org AND uploader_id=actor AND request_key=(input->>'key')::uuid;
  IF FOUND THEN
   IF e.work_id<>w.id OR e.digest IS DISTINCT FROM input->>'digest' OR e.bytes IS DISTINCT FROM (input->>'bytes')::int
    OR e.state='purged' OR e.expires_at<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Evidence retry conflict';END IF;
  ELSE
   IF (SELECT count(*) FROM ertad.work_evidence WHERE organization_id=org AND work_id=w.id AND uploader_id=actor)>=10 OR
      (SELECT count(*) FROM ertad.work_evidence WHERE organization_id=org AND work_id=w.id)>=100 THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Evidence capacity reached';END IF;
   INSERT INTO ertad.work_evidence(organization_id,work_id,uploader_id,request_key,digest,bytes)
    VALUES(org,w.id,actor,(input->>'key')::uuid,input->>'digest',(input->>'bytes')::int) RETURNING * INTO e;
  END IF;
  result:=jsonb_build_object('id',e.id,'state',e.state);
 ELSE
  SELECT * INTO e FROM ertad.work_evidence WHERE organization_id=org AND work_id=w.id AND id=(input->>'id')::uuid;
  IF NOT FOUND OR e.state='purged' OR e.expires_at<=clock_timestamp() OR (NOT reviewer AND e.uploader_id<>actor) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Evidence unavailable';END IF;
  IF op='ready' THEN
   IF NOT can_add OR e.uploader_id<>actor THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Upload authority expired';END IF;
   UPDATE ertad.work_evidence SET state='ready',expires_at=created_at+interval '90 days' WHERE organization_id=org AND id=e.id AND state='pending';
  ELSIF e.state<>'ready' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Evidence unavailable';END IF;
  result:=jsonb_build_object('id',e.id,'digest',e.digest,'bytes',e.bytes);
 END IF;
 RETURN jsonb_build_object('data',result,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'workId',w.id,'evidenceId',e.id,'operation',op));
END $$;
REVOKE ALL ON FUNCTION ertad.work_evidence_command(uuid,text,text,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.work_evidence_command(uuid,text,text,uuid,jsonb) TO ertad_app;
