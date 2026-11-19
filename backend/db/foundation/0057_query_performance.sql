-- Cache execution plans in PL/pgSQL for hot authority/hierarchy helpers and
-- evaluate unit-level review scopes once per unit rather than once per position.
-- All security boundaries, search_path settings, lock orderings, and post-audit
-- revalidation invariants remain unchanged.

CREATE INDEX IF NOT EXISTS memberships_org_user_idx ON ertad.memberships (organization_id, user_id);

CREATE OR REPLACE FUNCTION ertad.review_has_scope(member uuid, org uuid, target uuid, operation text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path=pg_catalog
AS $$
BEGIN
  RETURN EXISTS (
    WITH RECURSIVE path AS (
      SELECT id,parent_id,status FROM ertad.units WHERE organization_id=org AND id=target
      UNION
      SELECT u.id,u.parent_id,u.status FROM ertad.units u JOIN path p ON u.id=p.parent_id WHERE u.organization_id=org
    )
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
END;
$$;

CREATE OR REPLACE FUNCTION ertad.unit_path(org uuid, target uuid)
 RETURNS uuid[]
 LANGUAGE plpgsql
 STABLE
 SET search_path=pg_catalog
AS $$
DECLARE res uuid[];
BEGIN
  WITH RECURSIVE path AS (
    SELECT id,parent_id,0 AS depth FROM ertad.units WHERE organization_id=org AND id=target
    UNION ALL
    SELECT u.id,u.parent_id,p.depth+1 FROM ertad.units u JOIN path p ON u.id=p.parent_id
    WHERE u.organization_id=org AND p.depth<64
  )
  SELECT array_agg(id ORDER BY depth) INTO res FROM path;
  RETURN res;
END;
$$;

CREATE OR REPLACE FUNCTION ertad.member_unit_visible(actor uuid,org uuid,target uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
BEGIN
 RETURN ertad.review_has_scope(actor,org,target,'member.read') AND ertad.review_has_scope(actor,org,target,'unit.read');
END $$;

CREATE OR REPLACE FUNCTION ertad.member_memberships(actor uuid,org uuid,member uuid DEFAULT NULL,target uuid DEFAULT NULL) RETURNS SETOF ertad.memberships
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
BEGIN
 RETURN QUERY
 WITH visible_units AS MATERIALIZED (
   SELECT u.id FROM ertad.units u
   WHERE u.organization_id=org
     AND ertad.member_unit_visible(actor,org,u.id)
     AND (target IS NULL OR target=ANY(ertad.unit_path(org,u.id)))
 )
 SELECT m.* FROM ertad.memberships m
 JOIN visible_units vu ON vu.id=m.unit_id
 WHERE m.organization_id=org AND (member IS NULL OR m.user_id=member);
END $$;

CREATE OR REPLACE FUNCTION ertad.member_membership_state(m ertad.memberships) RETURNS text
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
BEGIN
 RETURN CASE WHEN m.status<>'active' THEN m.status
 WHEN m.valid_until<=clock_timestamp() THEN 'expired' WHEN m.valid_from>clock_timestamp() THEN 'scheduled'
 WHEN NOT EXISTS(SELECT 1 FROM ertad.positions p JOIN ertad.permission_bundles b ON (b.organization_id,b.id,b.version)=(p.organization_id,p.bundle_id,p.bundle_version)
 WHERE p.organization_id=m.organization_id AND p.id=m.position_id AND p.status='active' AND b.status='approved' AND p.bundle_version=m.bundle_version) THEN 'inactive'
 ELSE 'active' END;
END $$;

CREATE OR REPLACE FUNCTION ertad.member_points_scopes(actor uuid,org uuid,member uuid,target uuid) RETURNS TABLE(id uuid,name text)
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
BEGIN
 RETURN QUERY
 SELECT DISTINCT u.id,u.name FROM ertad.member_memberships(actor,org,member,target) m JOIN ertad.units u ON u.organization_id=org AND u.id=m.unit_id
 WHERE ertad.member_membership_state(m)='active' AND ertad.review_has_scope(actor,org,u.id,'contribution.read')
 AND ertad.review_has_scope(member,org,u.id,'unit.read');
END $$;

CREATE OR REPLACE FUNCTION ertad.member_summary(actor uuid,org uuid,member uuid,target uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE res jsonb;
BEGIN
 WITH mm AS MATERIALIZED (
   SELECT m AS rec, ertad.member_membership_state(m) AS m_state
   FROM ertad.member_memberships(actor,org,member,target) m
 ),
 scopes AS MATERIALIZED (
   SELECT DISTINCT u.id,u.name FROM mm m JOIN ertad.units u ON u.organization_id=org AND u.id=(m.rec).unit_id
   WHERE m.m_state='active' AND ertad.review_has_scope(actor,org,u.id,'contribution.read')
   AND ertad.review_has_scope(member,org,u.id,'unit.read')
 )
 SELECT jsonb_build_object('id',member,'displayName',(SELECT display_name FROM ertad.organization_member_labels WHERE organization_id=org AND member_id=member),
 'memberships',COALESCE((SELECT jsonb_agg(jsonb_build_object(
 'id',(m.rec).id,'unitId',(m.rec).unit_id,'unitName',u.name,'positionId',(m.rec).position_id,'positionName',p.name,
 'canChange',(m.rec).user_id<>actor AND ertad.review_has_scope(actor,org,(m.rec).unit_id,'membership.propose') AND (
 ((m.rec).status IN ('active','suspended') AND (m.rec).valid_from<=clock_timestamp() AND ((m.rec).valid_until IS NULL OR (m.rec).valid_until>clock_timestamp()))
 OR ertad.membership_pause_available(m.rec,'suspend') OR ertad.membership_pause_available(m.rec,'resume')
 ),
 'status',m.m_state,'validFrom',(m.rec).valid_from,'validUntil',(m.rec).valid_until) ORDER BY u.name,p.name,(m.rec).id)
 FROM mm m JOIN ertad.units u ON u.organization_id=org AND u.id=(m.rec).unit_id
 JOIN ertad.positions p ON p.organization_id=org AND p.id=(m.rec).position_id),'[]'),
 'points',CASE WHEN EXISTS(SELECT 1 FROM scopes) THEN
 (SELECT COALESCE(sum(e.points),0)::text FROM ertad.contribution_entries e WHERE e.organization_id=org AND e.user_id=member
 AND ertad.review_has_scope(actor,org,e.unit_id,'contribution.read') AND EXISTS(
 SELECT 1 FROM scopes s WHERE s.id=ANY(ertad.unit_path(org,e.unit_id)))) ELSE NULL END) INTO res;
 RETURN res;
END $$;

CREATE OR REPLACE FUNCTION ertad.membership_grant_command(sid uuid, token text, op text, org uuid, input jsonb) RETURNS jsonb
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
  PERFORM pg_advisory_xact_lock(752991884322001::bigint);
  PERFORM ertad.review_identity(sid,token,op IN ('propose','decide'));
  IF op='contexts' THEN
    SELECT COALESCE(jsonb_agg(x ORDER BY x->>'name'),'[]') INTO result FROM (
      SELECT jsonb_build_object('id',o.id,'name',o.name,'positions',(
        WITH unit_scopes AS MATERIALIZED (
          SELECT u.id, u.name,
            ertad.review_has_scope(actor,o.id,u.id,'membership.propose') AS can_propose,
            ertad.review_has_scope(actor,o.id,u.id,'membership.approve') AS can_approve
          FROM ertad.units u WHERE u.organization_id=o.id
        )
        SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'unitId',p.unit_id,'unitName',u.name,
          'canPropose',u.can_propose) ORDER BY u.name,p.name,p.id),'[]')
        FROM ertad.positions p JOIN unit_scopes u ON u.id=p.unit_id
        JOIN ertad.permission_bundles b ON (b.organization_id,b.id,b.version)=(p.organization_id,p.bundle_id,p.bundle_version)
        WHERE p.organization_id=o.id AND p.status='active' AND b.status='approved'
          AND (u.can_propose OR u.can_approve))) x
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

REVOKE ALL ON FUNCTION ertad.review_has_scope(uuid,uuid,uuid,text),ertad.unit_path(uuid,uuid),
  ertad.member_unit_visible(uuid,uuid,uuid),ertad.member_memberships(uuid,uuid,uuid,uuid),
  ertad.member_membership_state(ertad.memberships),ertad.member_points_scopes(uuid,uuid,uuid,uuid),
  ertad.member_summary(uuid,uuid,uuid,uuid),ertad.membership_grant_command(uuid,text,text,uuid,jsonb) FROM PUBLIC,ertad_app;

