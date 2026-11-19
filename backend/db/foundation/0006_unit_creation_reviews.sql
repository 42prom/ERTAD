-- Typed unit creation. Existing memberships never acquire this permission implicitly.
ALTER TABLE ertad.permission_grants DROP CONSTRAINT permission_grants_permission_check;
ALTER TABLE ertad.permission_grants ADD CONSTRAINT permission_grants_permission_check CHECK
  (permission IN ('unit.read','workitem.create','workitem.verify','membership.propose','membership.approve','unit.propose','unit.approve'));

CREATE TABLE ertad.unit_reviews (
  organization_id uuid NOT NULL REFERENCES ertad.organizations(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  parent_id uuid NOT NULL,
  parent_path uuid[] NOT NULL,
  name text NOT NULL CHECK (name=trim(name) AND length(name) BETWEEN 1 AND 160),
  requester_id uuid NOT NULL REFERENCES ertad.member_users(id),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 10 AND 1000),
  request_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decision_by uuid REFERENCES ertad.member_users(id),
  decision_key uuid,
  decision_reason text,
  decision_at timestamptz,
  unit_id uuid,
  PRIMARY KEY (organization_id,id),
  UNIQUE (organization_id,requester_id,request_key),
  FOREIGN KEY (organization_id,parent_id) REFERENCES ertad.units(organization_id,id),
  FOREIGN KEY (organization_id,unit_id) REFERENCES ertad.units(organization_id,id),
  CHECK (isfinite(expires_at) AND expires_at>created_at AND expires_at<=created_at+interval '7 days'),
  CHECK ((status='pending' AND decision_by IS NULL AND decision_key IS NULL AND decision_reason IS NULL AND decision_at IS NULL AND unit_id IS NULL)
    OR (status IN ('approved','rejected') AND decision_by IS NOT NULL AND decision_by<>requester_id
      AND decision_key IS NOT NULL AND decision_reason IS NOT NULL AND length(trim(decision_reason)) BETWEEN 10 AND 1000
      AND decision_at IS NOT NULL AND ((status='approved')=(unit_id IS NOT NULL))))
);
CREATE INDEX unit_reviews_queue ON ertad.unit_reviews(organization_id,status,expires_at,id);
CREATE FUNCTION ertad.freeze_unit_review() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Immutable review'; END IF;
  IF OLD.status<>'pending' OR NEW.status NOT IN ('approved','rejected') OR
    (to_jsonb(NEW)-ARRAY['status','decision_by','decision_key','decision_reason','decision_at','unit_id']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['status','decision_by','decision_key','decision_reason','decision_at','unit_id']) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Immutable review'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER freeze_unit_review BEFORE UPDATE OR DELETE ON ertad.unit_reviews FOR EACH ROW EXECUTE FUNCTION ertad.freeze_unit_review();
CREATE TRIGGER no_truncate_unit_review BEFORE TRUNCATE ON ertad.unit_reviews FOR EACH STATEMENT EXECUTE FUNCTION ertad.prevent_audit_log_mutation();

CREATE FUNCTION ertad.unit_path(org uuid, target uuid) RETURNS uuid[] LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  WITH RECURSIVE path AS (
    SELECT id,parent_id,0 AS depth FROM ertad.units WHERE organization_id=org AND id=target
    UNION ALL SELECT u.id,u.parent_id,p.depth+1 FROM ertad.units u JOIN path p ON u.id=p.parent_id WHERE u.organization_id=org
  ) SELECT array_agg(id ORDER BY depth) FROM path;
$$;
CREATE FUNCTION ertad.unit_review_visible(actor uuid,r ertad.unit_reviews) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT ertad.review_has_scope(actor,r.organization_id,r.parent_id,'unit.read') AND
    ((actor=r.requester_id AND ertad.review_has_scope(actor,r.organization_id,r.parent_id,'unit.propose'))
      OR (actor<>r.requester_id AND ertad.review_has_scope(actor,r.organization_id,r.parent_id,'unit.approve')));
$$;

CREATE FUNCTION ertad.unit_command(sid uuid,token text,op text,org uuid,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_column
DECLARE actor uuid; r ertad.unit_reviews; result jsonb; changed boolean:=false;
  parent uuid; expiry timestamptz; page integer; view_name text; new_unit uuid;
BEGIN
  IF op NOT IN ('contexts','units','list','detail','propose','decide') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid operation'; END IF;
  actor:=ertad.review_identity(sid,token,op IN ('propose','decide'));
  IF op='contexts' THEN
    PERFORM 1 FROM ertad.organizations o WHERE EXISTS(SELECT 1 FROM ertad.memberships m WHERE m.organization_id=o.id AND m.user_id=actor) ORDER BY o.id FOR SHARE;
  ELSIF op IN ('propose','decide') THEN
    PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
  ELSE
    PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(752991884322001::bigint);
  PERFORM ertad.review_identity(sid,token,op IN ('propose','decide'));
  IF op='contexts' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',o.id,'name',o.name) ORDER BY o.name,o.id),'[]') INTO result
      FROM ertad.organizations o WHERE o.status='active' AND EXISTS(SELECT 1 FROM ertad.units u
        WHERE u.organization_id=o.id AND ertad.review_has_scope(actor,o.id,u.id,'unit.read'));
  ELSIF op='units' THEN
    page:=COALESCE((input->>'page')::integer,1);
    IF page NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid page'; END IF;
    WITH visible AS (SELECT u.id,u.name,u.kind,
      CASE WHEN ertad.review_has_scope(actor,org,u.parent_id,'unit.read') THEN u.parent_id ELSE NULL END AS parent_id,
      CASE WHEN ertad.review_has_scope(actor,org,u.parent_id,'unit.read') THEN (SELECT p.name FROM ertad.units p WHERE p.organization_id=org AND p.id=u.parent_id) ELSE NULL END AS parent_name,
      ertad.review_has_scope(actor,org,u.id,'unit.propose') AND u.kind='authority' AS "canPropose"
      FROM ertad.units u WHERE u.organization_id=org AND ertad.review_has_scope(actor,org,u.id,'unit.read')
        AND position(lower(COALESCE(input->>'search','')) in lower(u.name))>0),
    paged AS (SELECT * FROM visible ORDER BY name,id LIMIT 25 OFFSET (page-1)*25)
    SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(to_jsonb(paged) ORDER BY name,id) FROM paged),'[]'),
      'total',(SELECT count(*) FROM visible),'page',page,'pageSize',25) INTO result;
  ELSIF op='propose' THEN
    parent:=(input->>'parentId')::uuid; expiry:=(input->>'expiresAt')::timestamptz;
    IF NOT ertad.review_has_scope(actor,org,parent,'unit.read') OR NOT ertad.review_has_scope(actor,org,parent,'unit.propose') THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
    SELECT * INTO r FROM ertad.unit_reviews WHERE organization_id=org AND requester_id=actor AND request_key=(input->>'key')::uuid;
    IF FOUND THEN
      IF (r.parent_id,r.name,r.reason,r.expires_at) IS DISTINCT FROM (parent,trim(input->>'name'),trim(input->>'reason'),expiry) THEN
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request conflict'; END IF;
    ELSE
      IF NOT EXISTS(SELECT 1 FROM ertad.units WHERE organization_id=org AND id=parent AND kind='authority' AND status='active')
        OR expiry<=clock_timestamp() OR expiry>clock_timestamp()+interval '7 days' THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid parent or deadline'; END IF;
      INSERT INTO ertad.unit_reviews(organization_id,parent_id,parent_path,name,requester_id,reason,request_key,expires_at)
        VALUES(org,parent,ertad.unit_path(org,parent),trim(input->>'name'),actor,trim(input->>'reason'),(input->>'key')::uuid,expiry) RETURNING * INTO r;
      changed:=true;
    END IF;
    result:=jsonb_build_object('id',r.id,'status',r.status,'unitId',r.unit_id);
  ELSIF op IN ('detail','decide') THEN
    SELECT * INTO r FROM ertad.unit_reviews WHERE organization_id=org AND id=(input->>'id')::uuid;
    IF NOT FOUND OR NOT ertad.unit_review_visible(actor,r) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
    IF op='decide' THEN
      IF actor=r.requester_id OR NOT ertad.review_has_scope(actor,org,r.parent_id,'unit.approve') THEN
        RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
      IF input->>'decision' NOT IN ('approved','rejected') OR length(trim(input->>'reason')) NOT BETWEEN 10 AND 1000 THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid decision'; END IF;
      IF r.status<>'pending' THEN
        IF (r.decision_by,r.decision_key,r.status,r.decision_reason) IS DISTINCT FROM (actor,(input->>'key')::uuid,input->>'decision',trim(input->>'reason')) THEN
          RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request conflict'; END IF;
      ELSE
        IF r.expires_at<=clock_timestamp() OR NOT ertad.review_has_scope(r.requester_id,org,r.parent_id,'unit.propose')
          OR NOT EXISTS(SELECT 1 FROM ertad.units WHERE organization_id=org AND id=r.parent_id AND kind='authority')
          OR NOT ertad.review_has_scope(r.requester_id,org,r.parent_id,'unit.read')
          OR r.parent_path IS DISTINCT FROM ertad.unit_path(org,r.parent_id) THEN
          RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request conflict'; END IF;
        IF input->>'decision'='approved' THEN
          IF EXISTS(SELECT 1 FROM ertad.units WHERE organization_id=org AND parent_id=r.parent_id AND status='active' AND lower(trim(name))=lower(r.name)) THEN
            RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Duplicate unit'; END IF;
          INSERT INTO ertad.units(organization_id,parent_id,name,kind) VALUES(org,r.parent_id,r.name,'authority') RETURNING id INTO new_unit;
        END IF;
        UPDATE ertad.unit_reviews SET status=input->>'decision',decision_by=actor,decision_key=(input->>'key')::uuid,
          decision_reason=trim(input->>'reason'),decision_at=clock_timestamp(),unit_id=new_unit WHERE organization_id=org AND id=r.id RETURNING * INTO r;
        changed:=true;
      END IF;
      result:=jsonb_build_object('id',r.id,'status',r.status,'unitId',r.unit_id);
    ELSE
      result:=(to_jsonb(r)-ARRAY['request_key','decision_key','parent_path'])||jsonb_build_object('parent_name',
        (SELECT name FROM ertad.units WHERE organization_id=org AND id=r.parent_id),
        'status',CASE WHEN r.status='pending' AND r.expires_at<=clock_timestamp() THEN 'expired' ELSE r.status END,
        'canDecide',r.status='pending' AND r.expires_at>clock_timestamp() AND actor<>r.requester_id AND ertad.review_has_scope(actor,org,r.parent_id,'unit.approve'));
    END IF;
  ELSE
    page:=COALESCE((input->>'page')::integer,1);view_name:=COALESCE(input->>'view','pending');
    IF page NOT BETWEEN 1 AND 1000 OR view_name NOT IN ('pending','mine','history') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid filter'; END IF;
    WITH visible AS (SELECT r.id,r.name,u.name AS parent_name,r.parent_id,r.created_at,r.expires_at,
      CASE WHEN r.status='pending' AND r.expires_at<=clock_timestamp() THEN 'expired' ELSE r.status END AS status
      FROM ertad.unit_reviews r JOIN ertad.units u ON (u.organization_id,u.id)=(r.organization_id,r.parent_id)
      WHERE r.organization_id=org AND ertad.unit_review_visible(actor,r)
      AND ((view_name='mine' AND r.requester_id=actor) OR (view_name='pending' AND r.requester_id<>actor AND r.status='pending' AND r.expires_at>clock_timestamp())
        OR (view_name='history' AND (r.status<>'pending' OR r.expires_at<=clock_timestamp())))),
    paged AS (SELECT * FROM visible ORDER BY expires_at,id LIMIT 25 OFFSET (page-1)*25)
    SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(to_jsonb(paged) ORDER BY expires_at,id) FROM paged),'[]'),
      'total',(SELECT count(*) FROM visible),'page',page,'pageSize',25) INTO result;
  END IF;
  RETURN jsonb_build_object('data',result,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'reviewId',r.id,'changed',changed));
END; $$;

CREATE FUNCTION ertad.unit_review_finish(sid uuid,token text,org uuid,rid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid; r ertad.unit_reviews;
BEGIN
  actor:=ertad.review_identity(sid,token,true);
  SELECT * INTO r FROM ertad.unit_reviews WHERE organization_id=org AND id=rid;
  IF NOT FOUND OR r.expires_at<=clock_timestamp() OR r.parent_path IS DISTINCT FROM ertad.unit_path(org,r.parent_id)
    OR NOT EXISTS(SELECT 1 FROM ertad.units WHERE organization_id=org AND id=r.parent_id AND kind='authority')
    OR NOT ertad.review_has_scope(r.requester_id,org,r.parent_id,'unit.propose')
    OR NOT ertad.review_has_scope(r.requester_id,org,r.parent_id,'unit.read')
    OR NOT ertad.review_has_scope(actor,org,r.parent_id,'unit.read')
    OR NOT ((r.status='pending' AND r.requester_id=actor) OR (r.status<>'pending' AND r.decision_by=actor AND ertad.review_has_scope(actor,org,r.parent_id,'unit.approve'))) THEN
    RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request conflict'; END IF;
END; $$;
REVOKE ALL ON FUNCTION ertad.freeze_unit_review(),ertad.unit_path(uuid,uuid),ertad.unit_review_visible(uuid,ertad.unit_reviews),
  ertad.unit_command(uuid,text,text,uuid,jsonb),ertad.unit_review_finish(uuid,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.unit_command(uuid,text,text,uuid,jsonb),ertad.unit_review_finish(uuid,text,uuid,uuid) TO ertad_app;
