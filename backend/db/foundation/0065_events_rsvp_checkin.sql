-- Event RSVP capacity, automatic waitlist promotion, manager QR check-in verification,
-- and event cloning without duplicating once-per-event participation rewards.

ALTER TABLE ertad.mobilization_events
  ADD COLUMN capacity_limit integer CHECK (capacity_limit IS NULL OR capacity_limit BETWEEN 1 AND 5000);

CREATE TABLE ertad.mobilization_event_rsvps (
  organization_id uuid NOT NULL,
  event_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES ertad.member_users(id),
  status text NOT NULL CHECK (status IN ('going', 'waitlist', 'cancelled', 'checked_in')),
  checkin_code text CHECK (checkin_code IS NULL OR checkin_code ~ '^[0-9A-F]{12}$'),
  checked_in_at timestamptz,
  checked_in_by uuid REFERENCES ertad.member_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, event_id, user_id),
  FOREIGN KEY (organization_id, event_id)
    REFERENCES ertad.mobilization_events(organization_id, id)
);

CREATE INDEX mobilization_event_waitlist_idx
  ON ertad.mobilization_event_rsvps (organization_id, event_id, created_at, user_id)
  WHERE status = 'waitlist';

CREATE UNIQUE INDEX mobilization_event_checkin_code_idx
  ON ertad.mobilization_event_rsvps (organization_id, event_id, checkin_code)
  WHERE checkin_code IS NOT NULL;

ALTER FUNCTION ertad.event_view(uuid, ertad.mobilization_events)
  RENAME TO event_before_rsvp_view;

CREATE FUNCTION ertad.event_view(actor uuid, e ertad.mobilization_events) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT ertad.event_before_rsvp_view(actor, e) || jsonb_build_object(
    'capacityLimit', e.capacity_limit,
    'goingCount', (
      SELECT count(*)::integer
      FROM ertad.mobilization_event_rsvps r
      WHERE r.organization_id = e.organization_id AND r.event_id = e.id AND r.status IN ('going', 'checked_in')
    ),
    'waitlistCount', (
      SELECT count(*)::integer
      FROM ertad.mobilization_event_rsvps r
      WHERE r.organization_id = e.organization_id AND r.event_id = e.id AND r.status = 'waitlist'
    ),
    'checkedInCount', (
      SELECT count(*)::integer
      FROM ertad.mobilization_event_rsvps r
      WHERE r.organization_id = e.organization_id AND r.event_id = e.id AND r.status = 'checked_in'
    ),
    'myRsvp', (
      SELECT jsonb_build_object('status', r.status, 'checkinCode', r.checkin_code)
      FROM ertad.mobilization_event_rsvps r
      WHERE r.organization_id = e.organization_id AND r.event_id = e.id AND r.user_id = actor
    )
  )
$$;

ALTER FUNCTION ertad.work_command(uuid, text, text, uuid, jsonb)
  RENAME TO work_before_event_rsvp_command;

CREATE FUNCTION ertad.work_command(
  sid uuid,
  token text,
  op text,
  org uuid,
  input jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  actor uuid;
  e ertad.mobilization_events;
  cloned ertad.mobilization_events;
  rsvp ertad.mobilization_event_rsvps;
  waiter ertad.mobilization_event_rsvps;
  receipt ertad.event_commands;
  result jsonb;
  data jsonb;
  fp text;
  cap_val integer;
  going_now integer;
  new_status text;
  new_code text;
  prev_status text;
  starts timestamptz;
  ends timestamptz;
  clean_input jsonb;
BEGIN
  IF op = 'event_create' OR op = 'event_edit' THEN
    clean_input := input - 'capacityLimit';
    result := ertad.work_before_event_rsvp_command(sid, token, op, org, clean_input);
    IF (input ? 'capacityLimit') AND COALESCE((result->'audit'->>'changed')::boolean, false) THEN
      IF input->'capacityLimit' IS NOT NULL AND jsonb_typeof(input->'capacityLimit') = 'number' THEN
        cap_val := (input->>'capacityLimit')::integer;
        IF cap_val NOT BETWEEN 1 AND 5000 THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid event capacity limit';
        END IF;
      ELSIF jsonb_typeof(input->'capacityLimit') = 'null' THEN
        cap_val := NULL;
      ELSE
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid event capacity limit';
      END IF;
      UPDATE ertad.mobilization_events
      SET capacity_limit = cap_val
      WHERE organization_id = org AND id = (result->'data'->>'id')::uuid;
    END IF;
    RETURN result;
  END IF;

  IF op NOT IN ('event_rsvp', 'event_checkin', 'event_clone') THEN
    RETURN ertad.work_before_event_rsvp_command(sid, token, op, org, input);
  END IF;

  -- event_rsvp is self-service for visible members without step-up; manager actions require step-up.
  actor := ertad.review_identity(sid, token, op <> 'event_rsvp');
  PERFORM 1 FROM ertad.organizations WHERE id = org AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
  END IF;
  PERFORM pg_advisory_xact_lock(752991884322001::bigint);
  PERFORM ertad.review_identity(sid, token, op <> 'event_rsvp');

  SELECT * INTO e
  FROM ertad.mobilization_events
  WHERE organization_id = org AND id = (input->>'id')::uuid
  FOR UPDATE;
  IF NOT FOUND OR NOT ertad.event_visible(actor, e) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
  END IF;

  fp := encode(sha256(convert_to((input - 'key')::text, 'UTF8')), 'hex');
  SELECT * INTO receipt
  FROM ertad.event_commands
  WHERE organization_id = org AND actor_id = actor AND key = (input->>'key')::uuid;
  IF FOUND THEN
    IF receipt.operation <> op OR receipt.fingerprint <> fp THEN
      RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Retry conflict';
    END IF;
    RETURN jsonb_build_object(
      'data', receipt.response,
      'audit', jsonb_build_object('actorId', actor, 'organizationId', org, 'operation', op, 'eventId', receipt.event_id, 'changed', false)
    );
  END IF;

  IF op = 'event_rsvp' THEN
    IF e.status <> 'open' OR e.ends_at <= clock_timestamp() THEN
      RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Event is no longer open for RSVP';
    END IF;
    IF NOT (
      ertad.review_has_scope(actor, org, e.unit_id, 'workitem.participate')
      OR ertad.review_has_scope(actor, org, e.unit_id, 'workitem.read')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
    END IF;

    SELECT * INTO rsvp
    FROM ertad.mobilization_event_rsvps
    WHERE organization_id = org AND event_id = e.id AND user_id = actor
    FOR UPDATE;
    prev_status := rsvp.status;

    IF input->>'action' = 'rsvp' THEN
      IF prev_status IN ('going', 'checked_in', 'waitlist') THEN
        new_status := prev_status;
        new_code := rsvp.checkin_code;
      ELSE
        SELECT count(*)::integer INTO going_now
        FROM ertad.mobilization_event_rsvps
        WHERE organization_id = org AND event_id = e.id AND status IN ('going', 'checked_in');
        IF e.capacity_limit IS NULL OR going_now < e.capacity_limit THEN
          new_status := 'going';
          new_code := upper(substr(encode(sha256(convert_to(org::text || ':' || e.id::text || ':' || actor::text || ':' || clock_timestamp()::text, 'UTF8')), 'hex'), 1, 12));
        ELSE
          new_status := 'waitlist';
          new_code := NULL;
        END IF;
        INSERT INTO ertad.mobilization_event_rsvps(organization_id, event_id, user_id, status, checkin_code, updated_at)
        VALUES (org, e.id, actor, new_status, new_code, clock_timestamp())
        ON CONFLICT (organization_id, event_id, user_id) DO UPDATE
          SET status = EXCLUDED.status,
              checkin_code = EXCLUDED.checkin_code,
              updated_at = clock_timestamp();
      END IF;
      data := jsonb_build_object('id', e.id, 'status', new_status, 'checkinCode', new_code);
    ELSIF input->>'action' = 'cancel' THEN
      IF prev_status IS NULL OR prev_status = 'cancelled' THEN
        new_status := 'cancelled';
      ELSE
        IF prev_status = 'checked_in' THEN
          RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Already checked in';
        END IF;
        UPDATE ertad.mobilization_event_rsvps
        SET status = 'cancelled', checkin_code = NULL, updated_at = clock_timestamp()
        WHERE organization_id = org AND event_id = e.id AND user_id = actor;
        new_status := 'cancelled';
        IF prev_status = 'going' AND e.capacity_limit IS NOT NULL THEN
          SELECT * INTO waiter
          FROM ertad.mobilization_event_rsvps
          WHERE organization_id = org AND event_id = e.id AND status = 'waitlist'
          ORDER BY created_at ASC, user_id ASC
          LIMIT 1
          FOR UPDATE;
          IF FOUND THEN
            UPDATE ertad.mobilization_event_rsvps
            SET status = 'going',
                checkin_code = upper(substr(encode(sha256(convert_to(org::text || ':' || e.id::text || ':' || waiter.user_id::text || ':' || clock_timestamp()::text, 'UTF8')), 'hex'), 1, 12)),
                updated_at = clock_timestamp()
            WHERE organization_id = org AND event_id = e.id AND user_id = waiter.user_id;
          END IF;
        END IF;
      END IF;
      data := jsonb_build_object('id', e.id, 'status', new_status);
    ELSE
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid RSVP action';
    END IF;
    INSERT INTO ertad.event_commands VALUES (org, actor, (input->>'key')::uuid, e.id, op, fp, data);
    RETURN jsonb_build_object(
      'data', data,
      'audit', jsonb_build_object('actorId', actor, 'organizationId', org, 'operation', op, 'eventId', e.id, 'changed', true)
    );
  END IF;

  IF NOT ertad.event_manager(actor, e) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
  END IF;

  IF op = 'event_checkin' THEN
    IF e.status <> 'open' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Event is not open';
    END IF;
    SELECT * INTO rsvp
    FROM ertad.mobilization_event_rsvps
    WHERE organization_id = org
      AND event_id = e.id
      AND checkin_code = upper(trim(COALESCE(input->>'checkinCode', '')))
      AND status = 'going'
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Valid RSVP check-in code not found';
    END IF;
    UPDATE ertad.mobilization_event_rsvps
    SET status = 'checked_in',
        checked_in_at = clock_timestamp(),
        checked_in_by = actor,
        updated_at = clock_timestamp()
    WHERE organization_id = org AND event_id = e.id AND user_id = rsvp.user_id;
    data := jsonb_build_object('id', e.id, 'checkedInAt', clock_timestamp(), 'status', 'checked_in');
    INSERT INTO ertad.event_commands VALUES (org, actor, (input->>'key')::uuid, e.id, op, fp, data);
    RETURN jsonb_build_object(
      'data', data,
      'audit', jsonb_build_object('actorId', actor, 'organizationId', org, 'operation', op, 'eventId', e.id, 'changed', true)
    );
  END IF;

  -- event_clone
  starts := (input->>'startsAt')::timestamptz;
  ends := (input->>'endsAt')::timestamptz;
  IF NOT isfinite(starts) OR NOT isfinite(ends) OR ends <= starts
     OR ends <= clock_timestamp() OR ends > clock_timestamp() + interval '365 days' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid event schedule';
  END IF;
  INSERT INTO ertad.mobilization_events(
    organization_id, unit_id, creator_id, title, description, location,
    starts_at, ends_at, scope_path, contribution_rule_id, capacity_limit
  )
  VALUES (
    org, e.unit_id, actor, e.title, e.description, e.location,
    starts, ends, ertad.unit_path(org, e.unit_id), e.contribution_rule_id, e.capacity_limit
  )
  RETURNING * INTO cloned;
  data := jsonb_build_object('id', cloned.id, 'version', cloned.version);
  INSERT INTO ertad.event_commands VALUES (org, actor, (input->>'key')::uuid, cloned.id, op, fp, data);
  RETURN jsonb_build_object(
    'data', data,
    'audit', jsonb_build_object('actorId', actor, 'organizationId', org, 'operation', op, 'eventId', cloned.id, 'sourceEventId', e.id, 'changed', true)
  );
END;
$$;

ALTER FUNCTION ertad.work_finish(uuid, text, text, uuid, jsonb, boolean)
  RENAME TO work_before_event_rsvp_finish;

CREATE FUNCTION ertad.work_finish(
  sid uuid,
  token text,
  op text,
  org uuid,
  input jsonb,
  changed boolean
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid;
  e ertad.mobilization_events;
BEGIN
  IF op IN ('event_rsvp', 'event_checkin', 'event_clone') THEN
    actor := ertad.review_identity(sid, token, op <> 'event_rsvp');
    SELECT * INTO e FROM ertad.mobilization_events WHERE organization_id = org AND id = (input->>'id')::uuid;
    IF NOT FOUND OR NOT ertad.event_visible(actor, e) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
    END IF;
    IF op IN ('event_checkin', 'event_clone') AND NOT ertad.event_manager(actor, e) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
    END IF;
    RETURN;
  END IF;
  PERFORM ertad.work_before_event_rsvp_finish(sid, token, op, org, input, changed);
END;
$$;

REVOKE ALL ON ertad.mobilization_event_rsvps FROM PUBLIC, ertad_app;
REVOKE ALL ON FUNCTION ertad.event_before_rsvp_view(uuid, ertad.mobilization_events),
  ertad.work_before_event_rsvp_command(uuid, text, text, uuid, jsonb),
  ertad.work_before_event_rsvp_finish(uuid, text, text, uuid, jsonb, boolean),
  ertad.event_view(uuid, ertad.mobilization_events) FROM PUBLIC, ertad_app;
REVOKE ALL ON FUNCTION ertad.work_command(uuid, text, text, uuid, jsonb),
  ertad.work_finish(uuid, text, text, uuid, jsonb, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.work_command(uuid, text, text, uuid, jsonb),
  ertad.work_finish(uuid, text, text, uuid, jsonb, boolean) TO ertad_app;

