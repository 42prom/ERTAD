-- Unified single-round-trip workspace bootstrap projection and scoped summary.
-- Preserves all lock ordering, authority predicates, and post-audit rechecks.

CREATE OR REPLACE FUNCTION ertad.workspace_bootstrap(sid uuid, token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  account uuid;
  actor uuid;
  grant_row ertad.platform_accounts;
  platform_access jsonb;
  reviews_ctx jsonb;
  review_count_json jsonb;
  pending_reviews integer := 0;
  units_ctx jsonb;
  decisions_ctx jsonb;
  work_ctx jsonb;
  collective_ctx jsonb;
  points_ctx jsonb;
  channels_ctx jsonb;
  members_ctx jsonb;
  positions_ctx jsonb;
  invitations_ctx jsonb;
  inbox_data jsonb;
  work_orgs uuid[];
  decision_orgs uuid[];
  collective_orgs uuid[];
  open_work integer := 0;
  offered_work integer := 0;
  overdue_work integer := 0;
  upcoming_events_48h integer := 0;
  open_decisions integer := 0;
  pending_collective integer := 0;
  schedule_data jsonb := '[]'::jsonb;
  urgent_data jsonb := '[]'::jsonb;
  now_ts timestamptz := clock_timestamp();
BEGIN
  SELECT admin_user_id INTO account
  FROM ertad.admin_sessions
  WHERE id = sid AND token_hash = token
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
  END IF;

  PERFORM 1 FROM ertad.admin_users WHERE id = account FOR SHARE;
  SELECT * INTO grant_row FROM ertad.platform_accounts WHERE admin_user_id = account FOR SHARE;
  PERFORM pg_advisory_xact_lock(752991884322001::bigint);

  IF NOT EXISTS (
    SELECT 1
    FROM ertad.admin_sessions s
    JOIN ertad.admin_users a ON a.id = s.admin_user_id
    WHERE s.id = sid
      AND s.token_hash = token
      AND s.revoked_at IS NULL
      AND s.idle_expires_at > clock_timestamp()
      AND s.absolute_expires_at > clock_timestamp()
      AND a.is_active
      AND (a.locked_until IS NULL OR a.locked_until <= clock_timestamp())
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
  END IF;

  platform_access := ertad.platform_console_command(sid, token, 'access', '{}'::jsonb)->'data';

  IF COALESCE((platform_access->>'technicalAccount')::boolean, false) THEN
    RETURN jsonb_build_object(
      'data', jsonb_build_object(
        'platformAccess', platform_access,
        'reviews', '[]'::jsonb,
        'reviewCount', null,
        'units', '[]'::jsonb,
        'decisions', '[]'::jsonb,
        'work', '[]'::jsonb,
        'collective', '[]'::jsonb,
        'points', '[]'::jsonb,
        'channels', '[]'::jsonb,
        'members', '[]'::jsonb,
        'positions', '[]'::jsonb,
        'invitations', '[]'::jsonb,
        'inbox', jsonb_build_object('contexts', '[]'::jsonb, 'unread', 0, 'actionRequired', 0),
        'summary', jsonb_build_object(
          'openWork', 0,
          'offeredWork', 0,
          'overdueWork', 0,
          'upcomingEvents48h', 0,
          'openDecisions', 0,
          'pendingReviews', 0,
          'pendingCollective', 0,
          'schedule', '[]'::jsonb,
          'urgent', '[]'::jsonb
        )
      ),
      'audit', jsonb_build_object('adminUserId', account, 'technicalAccount', true)
    );
  END IF;

  actor := ertad.review_identity(sid, token, false);

  reviews_ctx := COALESCE(ertad.membership_review_command(sid, token, 'contexts', NULL, '{}'::jsonb)->'data', '[]'::jsonb);
  SELECT COALESCE(SUM((ertad.membership_review_command(sid, token, 'list', (el->>'id')::uuid, '{"view":"pending","page":1}'::jsonb)->'data'->>'total')::integer), 0)
    INTO pending_reviews
  FROM jsonb_array_elements(reviews_ctx) AS el;
  review_count_json := CASE WHEN jsonb_array_length(reviews_ctx) > 0 THEN to_jsonb(pending_reviews) ELSE 'null'::jsonb END;

  units_ctx := COALESCE(ertad.unit_command(sid, token, 'contexts', NULL, '{}'::jsonb)->'data', '[]'::jsonb);
  decisions_ctx := COALESCE(ertad.decision_command(sid, token, 'contexts', NULL, '{}'::jsonb)->'data', '[]'::jsonb);
  work_ctx := COALESCE(ertad.work_command(sid, token, 'contexts', NULL, '{}'::jsonb)->'data', '[]'::jsonb);
  collective_ctx := COALESCE(ertad.collective_command(sid, token, 'contexts', NULL, '{}'::jsonb)->'data', '[]'::jsonb);
  points_ctx := COALESCE(ertad.collective_command(sid, token, 'point_contexts', NULL, '{}'::jsonb)->'data', '[]'::jsonb);
  channels_ctx := COALESCE(ertad.channel_command(sid, token, 'contexts', NULL, '{}'::jsonb, ''::text)->'data', '[]'::jsonb);
  members_ctx := COALESCE(ertad.member_directory_command(sid, token, 'contexts', NULL, '{}'::jsonb)->'data', '[]'::jsonb);
  positions_ctx := COALESCE(ertad.collective_command(sid, token, 'position_contexts', NULL, '{}'::jsonb)->'data', '[]'::jsonb);
  invitations_ctx := COALESCE(ertad.web_invite_command(sid, token, 'contexts', NULL, '{}'::jsonb)->'data', '[]'::jsonb);
  inbox_data := COALESCE(ertad.inbox_command(sid, token, 'summary', NULL, '{}'::jsonb)->'data', '{"contexts":[],"unread":0,"actionRequired":0}'::jsonb);

  SELECT COALESCE(array_agg((el->>'id')::uuid), '{}'::uuid[]) INTO work_orgs FROM jsonb_array_elements(work_ctx) el;
  SELECT COALESCE(array_agg((el->>'id')::uuid), '{}'::uuid[]) INTO decision_orgs FROM jsonb_array_elements(decisions_ctx) el;
  SELECT COALESCE(array_agg((el->>'id')::uuid), '{}'::uuid[]) INTO collective_orgs FROM jsonb_array_elements(collective_ctx) el;

  WITH visible_work AS MATERIALIZED (
    SELECT w.organization_id, w.id, w.title, w.status, w.deadline, w.priority
    FROM ertad.work_items w
    WHERE w.organization_id = ANY(work_orgs)
      AND w.status IN ('open', 'offered')
      AND ertad.work_visible(actor, w)
  ),
  visible_events AS MATERIALIZED (
    SELECT e.organization_id, e.id, e.title, e.starts_at
    FROM ertad.mobilization_events e
    WHERE e.organization_id = ANY(work_orgs)
      AND e.status = 'open'
      AND ertad.event_visible(actor, e)
  ),
  visible_decisions AS MATERIALIZED (
    SELECT d.organization_id, d.id, d.title, d.closes_at
    FROM ertad.decisions d
    WHERE d.organization_id = ANY(decision_orgs)
      AND d.status = 'open'
      AND d.closes_at > now_ts
      AND ertad.decision_visible(actor, d)
  ),
  visible_collective AS MATERIALIZED (
    SELECT p.organization_id, p.id, p.deadline
    FROM ertad.collective_proposals p
    WHERE p.organization_id = ANY(collective_orgs)
      AND p.status = 'pending'
      AND p.deadline > now_ts
      AND ertad.collective_visible(actor, p)
  ),
  days AS (
    SELECT gs AS day_offset, (now_ts::date + gs) AS day_date
    FROM pg_catalog.generate_series(0, 6) AS gs
  )
  SELECT
    COALESCE((SELECT count(*) FROM visible_work WHERE status = 'open'), 0),
    COALESCE((SELECT count(*) FROM visible_work WHERE status = 'offered'), 0),
    COALESCE((SELECT count(*) FROM visible_work WHERE deadline <= now_ts), 0),
    COALESCE((SELECT count(*) FROM visible_events WHERE starts_at >= now_ts AND starts_at <= now_ts + interval '48 hours'), 0),
    COALESCE((SELECT count(*) FROM visible_decisions), 0),
    COALESCE((SELECT count(*) FROM visible_collective), 0),
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'dayOffset', d.day_offset,
          'date', pg_catalog.to_char(d.day_date, 'YYYY-MM-DD'),
          'tasks', (SELECT count(*) FROM visible_work w WHERE w.deadline::date = d.day_date),
          'events', (SELECT count(*) FROM visible_events e WHERE e.starts_at::date = d.day_date),
          'decisions', (SELECT count(*) FROM visible_decisions dec WHERE dec.closes_at::date = d.day_date),
          'proposals', (SELECT count(*) FROM visible_collective col WHERE col.deadline::date = d.day_date)
        )
        ORDER BY d.day_offset
      )
      FROM days d
    ), '[]'::jsonb),
    COALESCE((
      SELECT jsonb_agg(u.item ORDER BY u.due_at ASC, u.id ASC)
      FROM (
        SELECT sub.due_at, sub.id, jsonb_build_object(
          'kind', sub.kind,
          'organizationId', sub.organization_id,
          'id', sub.id,
          'title', sub.title,
          'dueAt', sub.due_at,
          'overdue', sub.due_at <= now_ts,
          'route', sub.route
        ) AS item
        FROM (
          SELECT 'task'::text AS kind, organization_id, id, title, deadline AS due_at,
                 '/tasks'::text AS route
          FROM visible_work
          WHERE deadline <= now_ts + interval '7 days'
          UNION ALL
          SELECT 'event'::text AS kind, organization_id, id, title, starts_at AS due_at,
                 '/events'::text AS route
          FROM visible_events
          WHERE starts_at >= now_ts - interval '2 hours' AND starts_at <= now_ts + interval '7 days'
          UNION ALL
          SELECT 'decision'::text AS kind, organization_id, id, title, closes_at AS due_at,
                 '/decisions'::text AS route
          FROM visible_decisions
          WHERE closes_at <= now_ts + interval '7 days'
        ) sub
        ORDER BY sub.due_at ASC, sub.id ASC
        LIMIT 6
      ) u
    ), '[]'::jsonb)
  INTO
    open_work, offered_work, overdue_work, upcoming_events_48h,
    open_decisions, pending_collective, schedule_data, urgent_data;

  RETURN jsonb_build_object(
    'data', jsonb_build_object(
      'platformAccess', platform_access,
      'reviews', reviews_ctx,
      'reviewCount', review_count_json,
      'units', units_ctx,
      'decisions', decisions_ctx,
      'work', work_ctx,
      'collective', collective_ctx,
      'points', points_ctx,
      'channels', channels_ctx,
      'members', members_ctx,
      'positions', positions_ctx,
      'invitations', invitations_ctx,
      'inbox', inbox_data,
      'summary', jsonb_build_object(
        'openWork', open_work,
        'offeredWork', offered_work,
        'overdueWork', overdue_work,
        'upcomingEvents48h', upcoming_events_48h,
        'openDecisions', open_decisions,
        'pendingReviews', pending_reviews,
        'pendingCollective', pending_collective,
        'schedule', schedule_data,
        'urgent', urgent_data
      )
    ),
    'audit', jsonb_build_object(
      'actorId', actor,
      'technicalAccount', false,
      'organizationCount', jsonb_array_length(units_ctx)
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION ertad.workspace_bootstrap(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.workspace_bootstrap(uuid, text) TO ertad_app;

