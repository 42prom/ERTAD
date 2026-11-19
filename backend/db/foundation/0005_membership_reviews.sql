-- First recurring Approval: an existing member receives an approved position.
-- Runtime cannot write authority or approval tables directly.
CREATE TABLE ertad.membership_reviews (
  organization_id uuid NOT NULL REFERENCES ertad.organizations(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL REFERENCES ertad.member_users(id),
  target_id uuid NOT NULL REFERENCES ertad.member_users(id),
  unit_id uuid NOT NULL,
  position_id uuid NOT NULL,
  bundle_id uuid NOT NULL,
  bundle_version integer NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 10 AND 1000),
  valid_until timestamptz NOT NULL CHECK (isfinite(valid_until)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  request_key uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decision_by uuid REFERENCES ertad.member_users(id),
  decision_reason text,
  decision_at timestamptz,
  decision_key uuid,
  membership_id uuid,
  PRIMARY KEY (organization_id,id),
  UNIQUE (organization_id,requester_id,request_key),
  FOREIGN KEY (organization_id,unit_id,position_id) REFERENCES ertad.positions(organization_id,unit_id,id),
  FOREIGN KEY (organization_id,bundle_id,bundle_version) REFERENCES ertad.permission_bundles(organization_id,id,version),
  FOREIGN KEY (organization_id,membership_id) REFERENCES ertad.memberships(organization_id,id),
  CHECK (requester_id <> target_id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days'),
  CHECK (valid_until > expires_at AND valid_until <= created_at + interval '366 days'),
  CHECK ((status='pending' AND decision_by IS NULL AND decision_reason IS NULL AND decision_at IS NULL AND decision_key IS NULL AND membership_id IS NULL)
    OR (status IN ('approved','rejected') AND decision_by IS NOT NULL AND decision_by <> requester_id AND decision_by <> target_id
      AND decision_reason IS NOT NULL AND length(trim(decision_reason)) BETWEEN 10 AND 1000
      AND decision_at IS NOT NULL AND decision_key IS NOT NULL AND ((status='approved') = (membership_id IS NOT NULL))))
);
CREATE INDEX membership_reviews_queue ON ertad.membership_reviews(organization_id,status,expires_at,id);
CREATE TABLE ertad.review_notifications (
  organization_id uuid NOT NULL,
  review_id uuid NOT NULL,
  recipient_id uuid NOT NULL REFERENCES ertad.member_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  read_at timestamptz,
  PRIMARY KEY (organization_id,review_id,recipient_id),
  FOREIGN KEY (organization_id,review_id) REFERENCES ertad.membership_reviews(organization_id,id)
);
CREATE INDEX review_notifications_recipient ON ertad.review_notifications(organization_id,recipient_id,created_at,review_id);

CREATE FUNCTION ertad.freeze_membership_review() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Review history is immutable'; END IF;
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('approved','rejected') OR
    (to_jsonb(NEW) - ARRAY['status','decision_by','decision_reason','decision_at','decision_key','membership_id'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','decision_by','decision_reason','decision_at','decision_key','membership_id']) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Review history is immutable';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER freeze_review BEFORE UPDATE OR DELETE ON ertad.membership_reviews
  FOR EACH ROW EXECUTE FUNCTION ertad.freeze_membership_review();
CREATE TRIGGER no_truncate_review BEFORE TRUNCATE ON ertad.membership_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION ertad.prevent_audit_log_mutation();

-- Shared SQL authority projection for this database-owned command boundary.
-- Both the target and membership ancestry must reach an active root.
CREATE FUNCTION ertad.review_has_scope(member uuid, org uuid, target uuid, operation text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  WITH RECURSIVE path AS (
    SELECT id,parent_id,status FROM ertad.units WHERE organization_id=org AND id=target
    UNION
    SELECT u.id,u.parent_id,u.status FROM ertad.units u JOIN path p ON u.id=p.parent_id WHERE u.organization_id=org
  ) SELECT EXISTS (
    SELECT 1 FROM ertad.member_users u JOIN ertad.memberships m ON m.user_id=u.id
    JOIN ertad.positions p ON (p.organization_id,p.id,p.unit_id)=(m.organization_id,m.position_id,m.unit_id)
    JOIN ertad.permission_bundles b ON (b.organization_id,b.id,b.version)=(p.organization_id,p.bundle_id,p.bundle_version)
    JOIN ertad.permission_grants g ON (g.organization_id,g.bundle_id,g.bundle_version)=(b.organization_id,b.id,b.version)
    JOIN ertad.organizations o ON o.id=m.organization_id
    WHERE u.id=member AND u.status='active' AND o.id=org AND o.status='active'
      AND m.status='active' AND m.valid_from<=clock_timestamp() AND (m.valid_until IS NULL OR m.valid_until>clock_timestamp())
      AND p.status='active' AND b.status='approved' AND m.bundle_version=p.bundle_version
      AND g.permission=operation AND ((g.scope='unit' AND m.unit_id=target) OR (g.scope='subtree' AND m.unit_id IN (SELECT id FROM path)))
      AND EXISTS (SELECT 1 FROM path WHERE parent_id IS NULL)
      AND NOT EXISTS (SELECT 1 FROM path WHERE status<>'active')
  );
$$;

CREATE FUNCTION ertad.review_identity(sid uuid, token text, stepup boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE account uuid; member uuid;
BEGIN
  SELECT admin_user_id INTO account FROM ertad.admin_sessions WHERE id=sid AND token_hash=token FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
  PERFORM 1 FROM ertad.admin_users WHERE id=account FOR SHARE;
  SELECT id INTO member FROM ertad.member_users WHERE web_account_id=account FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
  IF NOT EXISTS (SELECT 1 FROM ertad.admin_sessions s JOIN ertad.admin_users a ON a.id=s.admin_user_id
    JOIN ertad.member_users m ON m.web_account_id=a.id WHERE s.id=sid AND s.token_hash=token
      AND s.revoked_at IS NULL AND s.idle_expires_at>clock_timestamp() AND s.absolute_expires_at>clock_timestamp()
      AND a.is_active AND (a.locked_until IS NULL OR a.locked_until<=clock_timestamp()) AND m.status='active') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied';
  END IF;
  IF stepup AND NOT EXISTS (SELECT 1 FROM ertad.admin_sessions WHERE id=sid AND step_up_expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION USING ERRCODE='P0428',MESSAGE='Reauthentication required';
  END IF;
  RETURN member;
END; $$;

CREATE FUNCTION ertad.review_visible(member uuid, r ertad.membership_reviews) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT (r.requester_id=member AND ertad.review_has_scope(member,r.organization_id,r.unit_id,'membership.propose'))
    OR (r.target_id<>member AND r.requester_id<>member AND ertad.review_has_scope(member,r.organization_id,r.unit_id,'membership.approve'))
    OR (r.target_id=member AND r.status<>'pending' AND ertad.review_has_scope(member,r.organization_id,r.unit_id,'unit.read'));
$$;

-- The only runtime command capability. All table writes, including membership
-- insertion, occur here after fresh server-state checks under organization locks.
CREATE FUNCTION ertad.membership_review_command(sid uuid, token text, op text, org uuid, input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_column
DECLARE actor uuid; r ertad.membership_reviews; p ertad.positions; result jsonb;
  changed boolean := false; target uuid; key uuid; until_at timestamptz; expiry timestamptz;
  rid uuid; decision text; membership uuid; page integer; view_name text; status_filter text; search_text text;
BEGIN
  IF op NOT IN ('contexts','list','detail','propose','decide','notifications','read') THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid operation'; END IF;
  actor := ertad.review_identity(sid,token,op IN ('propose','decide'));
  IF op='contexts' THEN
    PERFORM 1 FROM ertad.organizations o WHERE EXISTS(SELECT 1 FROM ertad.memberships m WHERE m.organization_id=o.id AND m.user_id=actor) ORDER BY o.id FOR SHARE;
  ELSE
    IF op IN ('propose','decide') THEN
      PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR UPDATE;
    ELSE
      PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR SHARE;
    END IF;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
  END IF;
  -- Same order as regular authority reads: session/account/member, organization,
  -- then audit. Evaluate deadlines only after any audit-chain wait has finished.
  PERFORM pg_advisory_xact_lock(752991884322001::bigint);
  PERFORM ertad.review_identity(sid,token,op IN ('propose','decide'));
  IF op='contexts' THEN
    SELECT COALESCE(jsonb_agg(x ORDER BY x->>'name'),'[]') INTO result FROM (
      SELECT jsonb_build_object('id',o.id,'name',o.name,'positions',(
        SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'unitId',p.unit_id,'unitName',u.name,
          'canPropose',ertad.review_has_scope(actor,o.id,p.unit_id,'membership.propose')) ORDER BY u.name,p.name,p.id),'[]')
        FROM ertad.positions p JOIN ertad.units u ON (u.organization_id,u.id)=(p.organization_id,p.unit_id)
        JOIN ertad.permission_bundles b ON (b.organization_id,b.id,b.version)=(p.organization_id,p.bundle_id,p.bundle_version)
        WHERE p.organization_id=o.id AND p.status='active' AND b.status='approved'
          AND (ertad.review_has_scope(actor,o.id,p.unit_id,'membership.propose') OR ertad.review_has_scope(actor,o.id,p.unit_id,'membership.approve')))) x
      FROM ertad.organizations o WHERE o.status='active' AND (EXISTS (
        SELECT 1 FROM ertad.memberships m WHERE m.organization_id=o.id AND m.user_id=actor AND
          (ertad.review_has_scope(actor,o.id,m.unit_id,'membership.propose') OR ertad.review_has_scope(actor,o.id,m.unit_id,'membership.approve')))
        OR EXISTS(SELECT 1 FROM ertad.review_notifications n JOIN ertad.membership_reviews nr ON (nr.organization_id,nr.id)=(n.organization_id,n.review_id)
          WHERE n.organization_id=o.id AND n.recipient_id=actor AND ertad.review_visible(actor,nr)))
    ) contexts;
  ELSIF op='propose' THEN
    target := (input->>'targetId')::uuid; key := (input->>'key')::uuid;
    until_at := (input->>'validUntil')::timestamptz; expiry := (input->>'expiresAt')::timestamptz;
    SELECT * INTO p FROM ertad.positions WHERE organization_id=org AND id=(input->>'positionId')::uuid;
    IF NOT FOUND OR target=actor OR NOT ertad.review_has_scope(actor,org,p.unit_id,'membership.propose') THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
    SELECT * INTO r FROM ertad.membership_reviews WHERE organization_id=org AND requester_id=actor AND request_key=key;
    IF FOUND THEN
      IF (r.target_id,r.position_id,r.reason,r.valid_until,r.expires_at) IS DISTINCT FROM
        (target,p.id,input->>'reason',until_at,expiry) THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request conflict'; END IF;
    ELSE
      PERFORM 1 FROM ertad.member_users WHERE id=target AND status='active' FOR SHARE;
      IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM ertad.memberships m WHERE m.organization_id=org AND m.user_id=target
        AND m.status='active' AND m.valid_from<=clock_timestamp() AND (m.valid_until IS NULL OR m.valid_until>clock_timestamp())) THEN
        RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
      IF p.status<>'active' OR NOT EXISTS (SELECT 1 FROM ertad.permission_bundles WHERE organization_id=org AND id=p.bundle_id AND version=p.bundle_version AND status='approved')
        OR expiry<=clock_timestamp() OR expiry>clock_timestamp()+interval '7 days' OR until_at<=expiry OR until_at>clock_timestamp()+interval '365 days' THEN
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request conflict'; END IF;
      IF EXISTS(SELECT 1 FROM ertad.memberships WHERE organization_id=org AND user_id=target AND position_id=p.id
        AND status='active' AND (valid_until IS NULL OR valid_until>clock_timestamp())) THEN
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request conflict'; END IF;
      INSERT INTO ertad.membership_reviews(organization_id,requester_id,target_id,unit_id,position_id,bundle_id,bundle_version,reason,valid_until,expires_at,request_key)
        VALUES(org,actor,target,p.unit_id,p.id,p.bundle_id,p.bundle_version,input->>'reason',until_at,expiry,key) RETURNING * INTO r;
      changed := true;
    END IF;
    result := jsonb_build_object('id',r.id,'status',r.status);
  ELSIF op='decide' THEN
    rid := (input->>'id')::uuid; key := (input->>'key')::uuid; decision := input->>'decision';
    SELECT * INTO r FROM ertad.membership_reviews WHERE organization_id=org AND id=rid FOR UPDATE;
    IF NOT FOUND OR actor IN (r.requester_id,r.target_id) OR NOT ertad.review_has_scope(actor,org,r.unit_id,'membership.approve') THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
    IF decision NOT IN ('approved','rejected') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid decision'; END IF;
    IF r.status<>'pending' THEN
      IF (r.status,r.decision_by,r.decision_key,r.decision_reason) IS DISTINCT FROM (decision,actor,key,input->>'reason') THEN
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request conflict'; END IF;
    ELSE
      PERFORM 1 FROM ertad.member_users WHERE id IN (r.requester_id,r.target_id) ORDER BY id FOR SHARE;
      IF r.expires_at<=clock_timestamp() OR r.valid_until<=clock_timestamp()
        OR NOT ertad.review_has_scope(r.requester_id,org,r.unit_id,'membership.propose') THEN
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request conflict'; END IF;
      IF decision='approved' THEN
        SELECT * INTO p FROM ertad.positions WHERE organization_id=org AND id=r.position_id;
        IF NOT FOUND OR p.status<>'active' OR (p.unit_id,p.bundle_id,p.bundle_version) IS DISTINCT FROM (r.unit_id,r.bundle_id,r.bundle_version)
          OR NOT EXISTS(SELECT 1 FROM ertad.permission_bundles WHERE organization_id=org AND id=r.bundle_id AND version=r.bundle_version AND status='approved')
          OR NOT EXISTS(SELECT 1 FROM ertad.member_users WHERE id=r.target_id AND status='active')
          OR NOT EXISTS(SELECT 1 FROM ertad.memberships WHERE organization_id=org AND user_id=r.target_id AND status='active'
            AND valid_from<=clock_timestamp() AND (valid_until IS NULL OR valid_until>clock_timestamp()))
          OR EXISTS(SELECT 1 FROM ertad.memberships WHERE organization_id=org AND user_id=r.target_id AND position_id=r.position_id
            AND status='active' AND (valid_until IS NULL OR valid_until>clock_timestamp())) THEN
          RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request conflict'; END IF;
        INSERT INTO ertad.memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until)
          VALUES(org,r.target_id,r.unit_id,r.position_id,r.bundle_version,clock_timestamp(),r.valid_until) RETURNING id INTO membership;
      END IF;
      UPDATE ertad.membership_reviews SET status=decision,decision_by=actor,decision_reason=input->>'reason',decision_at=clock_timestamp(),decision_key=key,membership_id=membership
        WHERE organization_id=org AND id=rid RETURNING * INTO r;
      INSERT INTO ertad.review_notifications(organization_id,review_id,recipient_id) VALUES(org,rid,r.requester_id),(org,rid,r.target_id);
      changed := true;
    END IF;
    result := jsonb_build_object('id',r.id,'status',r.status);
  ELSIF op IN ('detail','read') THEN
    SELECT * INTO r FROM ertad.membership_reviews WHERE organization_id=org AND id=(input->>'id')::uuid;
    IF NOT FOUND OR NOT ertad.review_visible(actor,r) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
    IF op='read' THEN
      UPDATE ertad.review_notifications SET read_at=COALESCE(read_at,clock_timestamp()) WHERE organization_id=org AND review_id=r.id AND recipient_id=actor;
      IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
      result := jsonb_build_object('id',r.id);
    ELSE
      result := (to_jsonb(r)-ARRAY['request_key','decision_key']) || jsonb_build_object('canDecide',r.status='pending' AND r.expires_at>clock_timestamp()
        AND actor NOT IN(r.requester_id,r.target_id) AND ertad.review_has_scope(actor,org,r.unit_id,'membership.approve'));
    END IF;
  ELSIF op='notifications' THEN
    SELECT jsonb_build_object('items',COALESCE(jsonb_agg(x ORDER BY x->>'created_at' DESC),'[]')) INTO result FROM (
      SELECT jsonb_build_object('id',n.review_id,'created_at',n.created_at,'read_at',n.read_at,'status',r.status) x
      FROM ertad.review_notifications n JOIN ertad.membership_reviews r ON (r.organization_id,r.id)=(n.organization_id,n.review_id)
      WHERE n.organization_id=org AND n.recipient_id=actor AND ertad.review_visible(actor,r)
      ORDER BY n.created_at DESC,n.review_id LIMIT 50
    ) notifications;
  ELSE
    page := COALESCE((input->>'page')::integer,1); view_name := COALESCE(input->>'view','pending');
    status_filter := COALESCE(input->>'status',''); search_text := COALESCE(input->>'search','');
    IF page NOT BETWEEN 1 AND 1000 OR view_name NOT IN ('pending','mine','history') OR status_filter NOT IN ('','pending','approved','rejected','expired') OR length(search_text)>80 THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid filter'; END IF;
    IF (input->>'from')::date > (input->>'to')::date THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid date range'; END IF;
    WITH visible AS (
      SELECT r.id,r.requester_id,r.unit_id,r.position_id,u.name AS unit_name,p.name AS position_name,r.created_at,r.expires_at,
        CASE WHEN r.status='pending' AND r.expires_at<=clock_timestamp() THEN 'expired' ELSE r.status END AS status
      FROM ertad.membership_reviews r JOIN ertad.units u ON (u.organization_id,u.id)=(r.organization_id,r.unit_id)
      JOIN ertad.positions p ON (p.organization_id,p.id)=(r.organization_id,r.position_id)
      WHERE r.organization_id=org AND ertad.review_visible(actor,r)
        AND (input->>'unitId' IS NULL OR r.unit_id=(input->>'unitId')::uuid)
        AND (input->>'from' IS NULL OR r.created_at >= ((input->>'from')::date::timestamp AT TIME ZONE 'UTC'))
        AND (input->>'to' IS NULL OR r.created_at < (((input->>'to')::date+1)::timestamp AT TIME ZONE 'UTC'))
        AND ((view_name='mine' AND r.requester_id=actor) OR (view_name='pending' AND r.status='pending' AND r.expires_at>clock_timestamp()
          AND actor NOT IN(r.requester_id,r.target_id) AND ertad.review_has_scope(actor,org,r.unit_id,'membership.approve'))
          OR (view_name='history' AND (r.status<>'pending' OR r.expires_at<=clock_timestamp())))
        AND (search_text='' OR position(lower(search_text) in lower(u.name||' '||p.name))>0)
    ), filtered AS (SELECT * FROM visible WHERE status_filter='' OR status=status_filter),
    paged AS (SELECT * FROM filtered ORDER BY expires_at,id LIMIT 25 OFFSET (page-1)*25)
    SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(to_jsonb(paged) ORDER BY expires_at,id) FROM paged),'[]'),
      'total',(SELECT count(*) FROM filtered),'page',page,'pageSize',25) INTO result;
  END IF;
  RETURN jsonb_build_object('data',result,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'reviewId',r.id,'changed',changed));
END; $$;

REVOKE ALL ON FUNCTION ertad.freeze_membership_review(),ertad.review_has_scope(uuid,uuid,uuid,text),ertad.review_identity(uuid,text,boolean),
  ertad.review_visible(uuid,ertad.membership_reviews),ertad.membership_review_command(uuid,text,text,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.membership_review_command(uuid,text,text,uuid,jsonb),ertad.review_identity(uuid,text,boolean) TO ertad_app;

-- Recheck temporal authority after strict audit persistence, before commit.
CREATE FUNCTION ertad.review_finish(sid uuid, token text, org uuid, rid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid; r ertad.membership_reviews;
BEGIN
  actor := ertad.review_identity(sid,token,true);
  SELECT * INTO r FROM ertad.membership_reviews WHERE organization_id=org AND id=rid;
  IF NOT FOUND OR r.expires_at<=clock_timestamp() OR r.valid_until<=clock_timestamp()
    OR NOT ertad.review_has_scope(r.requester_id,org,r.unit_id,'membership.propose')
    OR NOT ((r.status='pending' AND r.requester_id=actor) OR (r.status<>'pending' AND r.decision_by=actor
      AND ertad.review_has_scope(actor,org,r.unit_id,'membership.approve'))) THEN
    RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request conflict';
  END IF;
  IF r.status='approved' AND NOT EXISTS (SELECT 1 FROM ertad.memberships m WHERE m.organization_id=org AND m.user_id=r.target_id
    AND m.id<>r.membership_id AND m.status='active' AND m.valid_from<=clock_timestamp() AND (m.valid_until IS NULL OR m.valid_until>clock_timestamp())) THEN
    RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request conflict';
  END IF;
END; $$;
REVOKE ALL ON FUNCTION ertad.review_finish(uuid,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.review_finish(uuid,text,uuid,uuid) TO ertad_app;
