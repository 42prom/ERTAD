-- Manager-level operational shortfall views, privacy-safe bounded reports, and event/reminder inbox notifications.

CREATE TABLE ertad.event_inbox_reads (
  organization_id uuid NOT NULL,
  event_id uuid NOT NULL,
  recipient_id uuid NOT NULL REFERENCES ertad.member_users(id),
  read_version integer NOT NULL CHECK(read_version > 0),
  PRIMARY KEY(organization_id, event_id, recipient_id),
  FOREIGN KEY(organization_id, event_id) REFERENCES ertad.mobilization_events(organization_id, id)
);
REVOKE ALL ON ertad.event_inbox_reads FROM PUBLIC, ertad_app;

-- Extend work_overview with resourceShortfalls and dueSoon within the caller's exact scope.
CREATE OR REPLACE FUNCTION ertad.work_overview(actor uuid, org uuid, root_id uuid DEFAULT NULL, scope_unit uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  WITH RECURSIVE branch AS (
    SELECT w.* FROM ertad.work_items w WHERE w.organization_id=org AND w.id=root_id AND ertad.work_visible(actor,w)
    UNION ALL
    SELECT c.* FROM ertad.work_items c JOIN branch p ON c.organization_id=p.organization_id AND c.parent_id=p.id WHERE ertad.work_visible(actor,c)
  ), visible AS (
    SELECT w.* FROM ertad.work_items w WHERE root_id IS NULL AND w.organization_id=org AND ertad.work_visible(actor,w)
      AND (scope_unit IS NULL OR scope_unit=ANY(w.scope_path))
    UNION ALL
    SELECT * FROM branch
  )
  SELECT jsonb_build_object(
    'total',count(*),
    'active',count(*) FILTER(WHERE w.status IN ('offered','open')),
    'offered',count(*) FILTER(WHERE w.status='offered'),
    'completed',count(*) FILTER(WHERE w.status='completed'),
    'overdue',count(*) FILTER(WHERE w.status IN ('offered','open') AND w.deadline<=clock_timestamp()),
    'dueSoon',count(*) FILTER(WHERE w.status IN ('offered','open') AND w.deadline>clock_timestamp() AND w.deadline<=clock_timestamp()+interval '48 hours'),
    'blocked',count(*) FILTER(WHERE w.status IN ('offered','open') AND EXISTS(SELECT 1 FROM ertad.work_blockers b WHERE b.organization_id=org AND b.work_id=w.id AND b.resolved_at IS NULL)),
    'shortfalls',count(*) FILTER(WHERE w.status IN ('offered','open') AND EXISTS(
      SELECT 1 FROM ertad.work_needs n
      WHERE n.organization_id=org AND n.work_id=w.id AND NOT n.cancelled
        AND ertad.work_need_confirmed(n, false, actor) < n.quantity
    )),
    'reviewDue',count(*) FILTER(WHERE w.status IN ('offered','open') AND EXISTS(SELECT 1 FROM ertad.work_blockers b WHERE b.organization_id=org AND b.work_id=w.id AND b.resolved_at IS NULL AND b.next_review_at<=clock_timestamp())),
    'needsReview',count(*) FILTER(WHERE w.status='open' AND (
      EXISTS(SELECT 1 FROM ertad.work_criteria c WHERE c.organization_id=org AND c.work_id=w.id AND c.status='submitted')
      OR EXISTS(SELECT 1 FROM ertad.work_assignments a WHERE a.organization_id=org AND a.work_id=w.id AND a.status='submitted')
    )),
    'unowned',count(*) FILTER(WHERE w.status IN ('offered','open') AND NOT ertad.work_manager(w.coordinator_id,w)),
    'leafTotal',count(*) FILTER(WHERE w.status<>'cancelled' AND NOT EXISTS(SELECT 1 FROM ertad.work_items c WHERE c.organization_id=org AND c.parent_id=w.id AND c.status<>'cancelled' AND ertad.work_visible(actor,c))),
    'leafCompleted',count(*) FILTER(WHERE w.status='completed' AND NOT EXISTS(SELECT 1 FROM ertad.work_items c WHERE c.organization_id=org AND c.parent_id=w.id AND c.status<>'cancelled' AND ertad.work_visible(actor,c)))
  )
  FROM visible w
$$;

-- Extend work_command with 'shortfalls' list view and privacy-safe 'report' query.
ALTER FUNCTION ertad.work_command(uuid, text, text, uuid, jsonb) RENAME TO work_before_reporting_command;
CREATE FUNCTION ertad.work_command(sid uuid, token text, op text, org uuid, input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_column
DECLARE actor uuid; target uuid; page_no integer; view_name text; search_term text; result jsonb;
BEGIN
  IF op = 'report' OR (op = 'list' AND input->>'view' = 'shortfalls') THEN
    actor := ertad.review_identity(sid, token, false);
    PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
    PERFORM pg_advisory_xact_lock(752991884322001::bigint);
    PERFORM ertad.review_identity(sid, token, false);
    target := (input->>'unitId')::uuid;
    IF target IS NOT NULL AND NOT ertad.review_has_scope(actor, org, target, 'workitem.read') THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied';
    END IF;
    view_name := COALESCE(input->>'view', 'all');
    search_term := lower(COALESCE(input->>'search', ''));
    IF length(search_term) > 80 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid filter'; END IF;
    IF op = 'list' THEN
      page_no := COALESCE((input->>'page')::integer, 1);
      IF page_no NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid page'; END IF;
      WITH visible AS (
        SELECT w.* FROM ertad.work_items w
        WHERE w.organization_id=org AND ertad.work_visible(actor, w)
          AND (target IS NULL OR target=ANY(w.scope_path))
          AND position(search_term IN lower(w.title)) > 0
          AND w.status IN ('offered','open')
          AND EXISTS(
            SELECT 1 FROM ertad.work_needs n
            WHERE n.organization_id=org AND n.work_id=w.id AND NOT n.cancelled
              AND ertad.work_need_confirmed(n, false, actor) < n.quantity
          )
      ),
      paged AS (SELECT * FROM visible ORDER BY created_at DESC, id LIMIT 25 OFFSET (page_no - 1) * 25)
      SELECT jsonb_build_object(
        'items', COALESCE((SELECT jsonb_agg(ertad.work_view(actor, paged::ertad.work_items) ORDER BY created_at DESC, id) FROM paged), '[]'),
        'total', (SELECT count(*) FROM visible),
        'page', page_no,
        'pageSize', 25
      ) INTO result;
      RETURN jsonb_build_object('data', result, 'audit', jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'changed',false));
    END IF;

    IF view_name NOT IN ('all','open','offered','completed','cancelled','blocked','overdue','needs_review','shortfalls') THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid report filter';
    END IF;
    -- Privacy-safe report: bounded 250 rows, aggregated counts only, no member/identity fields.
    WITH visible AS (
      SELECT w.* FROM ertad.work_items w
      WHERE w.organization_id=org AND ertad.work_visible(actor, w)
        AND (target IS NULL OR target=ANY(w.scope_path))
        AND position(search_term IN lower(w.title)) > 0
        AND CASE view_name
          WHEN 'all' THEN true
          WHEN 'blocked' THEN w.status IN ('offered','open') AND EXISTS(SELECT 1 FROM ertad.work_blockers b WHERE b.organization_id=org AND b.work_id=w.id AND b.resolved_at IS NULL)
          WHEN 'overdue' THEN w.status IN ('offered','open') AND w.deadline<=clock_timestamp()
          WHEN 'needs_review' THEN w.status='open' AND (ertad.work_tracking(w)->>'pendingReview')::int>0
          WHEN 'shortfalls' THEN w.status IN ('offered','open') AND EXISTS(
            SELECT 1 FROM ertad.work_needs n WHERE n.organization_id=org AND n.work_id=w.id AND NOT n.cancelled AND ertad.work_need_confirmed(n, false, actor) < n.quantity
          )
          ELSE w.status=view_name END
    ),
    bounded AS (SELECT * FROM visible ORDER BY created_at DESC, id LIMIT 250)
    SELECT jsonb_build_object(
      'items', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', b.id,
        'unitName', (SELECT name FROM ertad.units u WHERE u.organization_id=org AND u.id=b.unit_id),
        'title', b.title,
        'status', b.status,
        'priority', b.priority,
        'capacity', b.capacity,
        'used', ertad.work_used(b),
        'verified', (SELECT count(*)::integer FROM ertad.work_assignments a WHERE a.organization_id=org AND a.work_id=b.id AND a.status='verified'),
        'overdue', b.status IN ('offered','open') AND b.deadline<=clock_timestamp(),
        'blocked', EXISTS(SELECT 1 FROM ertad.work_blockers bl WHERE bl.organization_id=org AND bl.work_id=b.id AND bl.resolved_at IS NULL),
        'shortfalls', (SELECT count(*)::integer FROM ertad.work_needs n WHERE n.organization_id=org AND n.work_id=b.id AND NOT n.cancelled AND ertad.work_need_confirmed(n, false, actor) < n.quantity),
        'deadline', b.deadline
      ) ORDER BY b.created_at DESC, b.id) FROM bounded b), '[]'),
      'total', (SELECT count(*)::integer FROM visible),
      'truncated', (SELECT count(*) FROM visible) > 250,
      'generatedAt', clock_timestamp()
    ) INTO result;
    RETURN jsonb_build_object('data', result, 'audit', jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'changed',false));
  END IF;
  RETURN ertad.work_before_reporting_command(sid, token, op, org, input);
END $$;

-- Extend decision_command with privacy-safe bounded 'report' operation.
ALTER FUNCTION ertad.decision_command(uuid, text, text, uuid, jsonb) RENAME TO decision_before_reporting_command;
CREATE FUNCTION ertad.decision_command(sid uuid, token text, op text, org uuid, input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_column
DECLARE actor uuid; view_name text; search_term text; result jsonb;
BEGIN
  IF op = 'report' THEN
    actor := ertad.review_identity(sid, token, false);
    PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
    PERFORM pg_advisory_xact_lock(752991884322001::bigint);
    PERFORM ertad.review_identity(sid, token, false);
    view_name := COALESCE(input->>'view', 'all');
    search_term := lower(COALESCE(input->>'search', ''));
    IF view_name NOT IN ('all','draft','scheduled','open','closed','cancelled') OR length(search_term) > 80 THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid decision report filter';
    END IF;
    WITH visible AS (
      SELECT d.*,
        CASE WHEN d.status='open' AND d.closes_at<=clock_timestamp() THEN 'closed'
             WHEN d.status='open' AND d.opens_at IS NOT NULL AND d.opens_at>clock_timestamp() THEN 'scheduled'
             ELSE d.status END AS effective_status
      FROM ertad.decisions d
      WHERE d.organization_id=org AND ertad.decision_visible(actor, d)
        AND position(search_term IN lower(d.title)) > 0
    ),
    filtered AS (
      SELECT * FROM visible WHERE view_name='all' OR effective_status=view_name
    ),
    bounded AS (SELECT * FROM filtered ORDER BY created_at DESC, id LIMIT 250)
    SELECT jsonb_build_object(
      'items', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', b.id,
        'unitName', (SELECT name FROM ertad.units u WHERE u.organization_id=org AND u.id=b.unit_id),
        'title', b.title,
        'kind', b.kind,
        'status', b.effective_status,
        'privacy', b.privacy,
        'governanceMode', b.governance_mode,
        'electorate', (SELECT count(*)::integer FROM ertad.decision_electorate e WHERE e.organization_id=org AND e.decision_id=b.id),
        'quorum', b.quorum,
        'participation', CASE
          WHEN b.effective_status <> 'closed' THEN NULL
          WHEN b.privacy='anonymous' AND (SELECT count(*) FROM ertad.decision_electorate e WHERE e.organization_id=org AND e.decision_id=b.id) < 10 THEN NULL
          WHEN b.privacy='anonymous' THEN (SELECT count(*)::integer FROM ertad.decision_anonymous_participation p WHERE p.organization_id=org AND p.decision_id=b.id)
          WHEN b.kind='survey' THEN (SELECT count(*)::integer FROM ertad.decision_survey_responses s WHERE s.organization_id=org AND s.decision_id=b.id)
          ELSE (SELECT count(*)::integer FROM ertad.decision_named_votes v WHERE v.organization_id=org AND v.decision_id=b.id)
        END,
        'closesAt', b.closes_at
      ) ORDER BY b.created_at DESC, b.id) FROM bounded b), '[]'),
      'total', (SELECT count(*)::integer FROM filtered),
      'truncated', (SELECT count(*) FROM filtered) > 250,
      'generatedAt', clock_timestamp()
    ) INTO result;
    RETURN jsonb_build_object('data', result, 'audit', jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'decisionId',NULL,'changed',false));
  END IF;
  RETURN ertad.decision_before_reporting_command(sid, token, op, org, input);
END $$;

-- Surface scoped mobilization event updates/reminders in the unified inbox without disclosing hidden branches.
ALTER FUNCTION ertad.inbox_entries(uuid, uuid) RENAME TO inbox_before_events_entries;
CREATE FUNCTION ertad.inbox_entries(actor uuid, org uuid) RETURNS TABLE(
  source text, id uuid, version integer, unit_id uuid, title text, status text, updated_at timestamptz, deadline timestamptz, unread boolean, action text
) LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT * FROM ertad.inbox_before_events_entries(actor, org)
  UNION ALL
  SELECT 'event'::text, e.id, e.version, e.unit_id, e.title, e.status,
    COALESCE((SELECT max(h.created_at) FROM ertad.mobilization_event_history h WHERE h.organization_id=org AND h.event_id=e.id), e.created_at),
    e.starts_at,
    COALESCE(rd.read_version, 0) < e.version,
    CASE WHEN e.status='open' AND e.starts_at > clock_timestamp() AND e.starts_at <= clock_timestamp() + interval '48 hours' AND ertad.event_manager(actor, e)
         THEN 'event_follow_up' ELSE '' END
  FROM ertad.mobilization_events e
  LEFT JOIN ertad.event_inbox_reads rd ON rd.organization_id=org AND rd.event_id=e.id AND rd.recipient_id=actor
  WHERE e.organization_id=org AND ertad.event_visible(actor, e)
    AND (e.version > 1 OR (e.status='open' AND e.starts_at <= clock_timestamp() + interval '48 hours' AND e.ends_at > clock_timestamp()))
$$;

CREATE OR REPLACE FUNCTION ertad.inbox_command(sid uuid, token text, op text, org uuid, input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid; result jsonb; item record; requested integer; page integer; view_name text; source_name text;
BEGIN
  IF op NOT IN ('summary','list','read') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid inbox operation'; END IF;
  actor:=ertad.review_identity(sid,token,false);
  IF op='summary' THEN
    PERFORM 1 FROM ertad.organizations o WHERE EXISTS(SELECT 1 FROM ertad.memberships m WHERE m.organization_id=o.id AND m.user_id=actor) ORDER BY o.id FOR SHARE;
  ELSIF op='read' THEN PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR UPDATE;
  ELSE PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR SHARE; END IF;
  PERFORM pg_advisory_xact_lock(752991884322001::bigint); PERFORM ertad.review_identity(sid,token,false);
  IF op<>'summary' AND NOT EXISTS(SELECT 1 FROM ertad.inbox_contexts(actor) c WHERE c.id=org) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Inbox unavailable'; END IF;
  IF op='summary' THEN
    WITH contexts AS MATERIALIZED(SELECT * FROM ertad.inbox_contexts(actor)), entries AS MATERIALIZED(SELECT e.* FROM contexts c CROSS JOIN LATERAL ertad.inbox_entries(actor,c.id) e)
    SELECT jsonb_build_object(
      'contexts',COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.name,c.id) FROM contexts c),'[]'),
      'unread',(SELECT count(*) FROM entries WHERE unread),
      'actionRequired',(SELECT count(*) FROM entries WHERE action<>'')
    ) INTO result;
  ELSIF op='list' THEN
    page:=COALESCE((input->>'page')::int,1); view_name:=COALESCE(input->>'view','action'); source_name:=COALESCE(input->>'source','all');
    IF page NOT BETWEEN 1 AND 1000 OR view_name NOT IN ('all','unread','action')
    OR source_name NOT IN ('all','membership','unit','work','collective','decision','moderation','contribution','event') THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid inbox filter';
    END IF;
    WITH visible AS MATERIALIZED(SELECT * FROM ertad.inbox_entries(actor,org) e WHERE (source_name='all' OR e.source=source_name)),
    filtered AS(SELECT * FROM visible WHERE CASE view_name WHEN 'unread' THEN unread WHEN 'action' THEN action<>'' ELSE true END),
    paged AS(SELECT * FROM filtered ORDER BY updated_at DESC,source,id LIMIT 25 OFFSET (page-1)*25)
    SELECT jsonb_build_object(
      'items',COALESCE((SELECT jsonb_agg(jsonb_build_object('source',p.source,'id',p.id,'version',p.version,'unitId',p.unit_id,
        'unitName',CASE WHEN ertad.review_has_scope(actor,org,p.unit_id,'unit.read') THEN (SELECT name FROM ertad.units WHERE organization_id=org AND id=p.unit_id) END,
        'title',p.title,'status',p.status,'updatedAt',p.updated_at,'deadline',p.deadline,'unread',p.unread,'action',p.action) ORDER BY p.updated_at DESC,p.source,p.id) FROM paged p),'[]'),
      'total',(SELECT count(*) FROM filtered),'unread',(SELECT count(*) FROM visible WHERE unread),'actionRequired',(SELECT count(*) FROM visible WHERE action<>''),'page',page,'pageSize',25
    ) INTO result;
  ELSE
    SELECT * INTO item FROM ertad.inbox_entries(actor,org) e WHERE e.source=input->>'source' AND e.id=(input->>'id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Inbox item unavailable'; END IF;
    requested:=(input->>'version')::int;
    IF requested IS NULL OR requested<1 OR requested>item.version THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Observed version required'; END IF;
    IF item.source='membership' THEN
      INSERT INTO ertad.membership_inbox_reads VALUES(org,item.id,actor,requested) ON CONFLICT(organization_id,review_id,recipient_id) DO UPDATE SET read_version=greatest(membership_inbox_reads.read_version,excluded.read_version);
      IF requested>=item.version THEN UPDATE ertad.review_notifications SET read_at=COALESCE(read_at,clock_timestamp()) WHERE organization_id=org AND review_id=item.id AND recipient_id=actor; END IF;
    ELSIF item.source='unit' THEN
      INSERT INTO ertad.unit_inbox_reads VALUES(org,item.id,actor,requested) ON CONFLICT(organization_id,review_id,recipient_id) DO UPDATE SET read_version=greatest(unit_inbox_reads.read_version,excluded.read_version);
    ELSIF item.source='work' THEN
      UPDATE ertad.work_notifications SET read_at=COALESCE(read_at,clock_timestamp()) WHERE organization_id=org AND work_id=item.id AND recipient_id=actor AND version<=requested;
    ELSIF item.source='contribution' THEN
      INSERT INTO ertad.contribution_inbox_reads VALUES(org,item.id,actor) ON CONFLICT DO NOTHING;
    ELSIF item.source='moderation' THEN
      INSERT INTO ertad.moderation_inbox_reads VALUES(org,item.id,actor,requested) ON CONFLICT(organization_id,restriction_id,recipient_id) DO UPDATE SET read_version=greatest(moderation_inbox_reads.read_version,excluded.read_version);
    ELSIF item.source='decision' THEN
      INSERT INTO ertad.decision_inbox_reads VALUES(org,item.id,actor,requested) ON CONFLICT(organization_id,decision_id,recipient_id) DO UPDATE SET read_version=greatest(decision_inbox_reads.read_version,excluded.read_version);
    ELSIF item.source='event' THEN
      INSERT INTO ertad.event_inbox_reads VALUES(org,item.id,actor,requested) ON CONFLICT(organization_id,event_id,recipient_id) DO UPDATE SET read_version=greatest(event_inbox_reads.read_version,excluded.read_version);
    ELSE
      UPDATE ertad.collective_notifications SET read_version=greatest(read_version,requested) WHERE organization_id=org AND proposal_id=item.id AND recipient_id=actor;
    END IF;
    result:=jsonb_build_object('id',item.id,'version',requested);
  END IF;
  RETURN jsonb_build_object('data',result,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'source',input->>'source','recordId',input->>'id'));
END $$;

REVOKE ALL ON FUNCTION ertad.work_before_reporting_command(uuid, text, text, uuid, jsonb),
  ertad.decision_before_reporting_command(uuid, text, text, uuid, jsonb),
  ertad.inbox_before_events_entries(uuid, uuid),
  ertad.inbox_entries(uuid, uuid) FROM PUBLIC, ertad_app;
REVOKE ALL ON FUNCTION ertad.work_command(uuid, text, text, uuid, jsonb),
  ertad.decision_command(uuid, text, text, uuid, jsonb),
  ertad.inbox_command(uuid, text, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.work_command(uuid, text, text, uuid, jsonb),
  ertad.decision_command(uuid, text, text, uuid, jsonb),
  ertad.inbox_command(uuid, text, text, uuid, jsonb) TO ertad_app;

