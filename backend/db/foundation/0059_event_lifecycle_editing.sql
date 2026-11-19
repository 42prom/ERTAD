-- Explicit event editing, rescheduling, history and cascade-safe cancellation within Work.
CREATE TABLE ertad.mobilization_event_history (
  organization_id uuid NOT NULL,
  event_id uuid NOT NULL,
  version integer NOT NULL CHECK(version > 0),
  actor_id uuid NOT NULL REFERENCES ertad.member_users(id),
  action text NOT NULL CHECK(action IN ('edit','complete','cancel')),
  note text NOT NULL CHECK(length(note) <= 1000),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(organization_id, event_id, version),
  FOREIGN KEY(organization_id, event_id) REFERENCES ertad.mobilization_events(organization_id, id)
);
CREATE INDEX mobilization_event_history_recent ON ertad.mobilization_event_history(organization_id, event_id, version DESC);
CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON ertad.mobilization_event_history
  FOR EACH ROW EXECUTE FUNCTION ertad.prevent_audit_log_mutation();
CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON ertad.mobilization_event_history
  FOR EACH STATEMENT EXECUTE FUNCTION ertad.prevent_audit_log_mutation();
REVOKE ALL ON ertad.mobilization_event_history FROM PUBLIC, ertad_app;

CREATE FUNCTION ertad.event_snapshot(e ertad.mobilization_events) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object(
    'title', e.title,
    'description', e.description,
    'location', e.location,
    'startsAt', e.starts_at,
    'endsAt', e.ends_at,
    'status', e.status
  )
$$;

CREATE FUNCTION ertad.event_linked_summary(org uuid, target_event uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object(
    'totalTasks', (SELECT count(*)::integer FROM ertad.work_items w WHERE w.organization_id=org AND w.event_id=target_event),
    'openTasks', (SELECT count(*)::integer FROM ertad.work_items w WHERE w.organization_id=org AND w.event_id=target_event AND w.status IN ('open','offered')),
    'verifiedOpenTasks', (SELECT count(*)::integer FROM ertad.work_items w WHERE w.organization_id=org AND w.event_id=target_event AND w.status IN ('open','offered')
      AND (EXISTS(SELECT 1 FROM ertad.work_assignments a WHERE a.organization_id=org AND a.work_id=w.id AND a.status='verified')
        OR EXISTS(SELECT 1 FROM ertad.work_items c WHERE c.organization_id=org AND c.parent_id=w.id AND c.status='completed'))),
    'cancellableOpenTasks', (SELECT count(*)::integer FROM ertad.work_items w WHERE w.organization_id=org AND w.event_id=target_event AND w.status IN ('open','offered')
      AND NOT EXISTS(SELECT 1 FROM ertad.work_assignments a WHERE a.organization_id=org AND a.work_id=w.id AND a.status='verified')
      AND NOT EXISTS(SELECT 1 FROM ertad.work_items c WHERE c.organization_id=org AND c.parent_id=w.id AND c.status='completed')),
    'completedTasks', (SELECT count(*)::integer FROM ertad.work_items w WHERE w.organization_id=org AND w.event_id=target_event AND w.status='completed'),
    'cancelledTasks', (SELECT count(*)::integer FROM ertad.work_items w WHERE w.organization_id=org AND w.event_id=target_event AND w.status='cancelled'),
    'claimsCount', (SELECT count(*)::integer FROM ertad.event_participation_claims ep WHERE ep.organization_id=org AND ep.event_id=target_event)
  )
$$;

ALTER FUNCTION ertad.work_command(uuid, text, text, uuid, jsonb) RENAME TO work_before_event_editing_command;
CREATE FUNCTION ertad.work_command(sid uuid, token text, op text, org uuid, input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_column
DECLARE
  actor uuid;
  e ertad.mobilization_events;
  previous ertad.mobilization_events;
  receipt ertad.event_commands;
  result jsonb;
  data jsonb;
  fp text;
  starts timestamptz;
  ends timestamptz;
  note_text text;
  cascade_cancel boolean;
  cancelled_count integer:=0;
  preserved_completed integer:=0;
  preserved_claims integer:=0;
  w_row ertad.work_items;
  events_history jsonb;
BEGIN
  IF op = 'event_detail' THEN
    result := ertad.work_before_event_editing_command(sid, token, op, org, input);
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'version', h.version,
      'action', h.action,
      'note', h.note,
      'details', h.details,
      'createdAt', h.created_at
    ) ORDER BY h.version DESC), '[]'::jsonb)
    INTO events_history
    FROM (
      SELECT version, action, note, details, created_at
      FROM ertad.mobilization_event_history
      WHERE organization_id=org AND event_id=(result->'data'->>'id')::uuid
      ORDER BY version DESC LIMIT 50
    ) h;
    result := jsonb_set(
      result,
      '{data}',
      (result->'data') || jsonb_build_object(
        'linkedSummary', ertad.event_linked_summary(org, (result->'data'->>'id')::uuid),
        'history', events_history
      )
    );
    RETURN result;
  END IF;

  IF op NOT IN ('event_edit', 'event_cancel', 'event_complete') THEN
    RETURN ertad.work_before_event_editing_command(sid, token, op, org, input);
  END IF;

  IF op = 'event_complete' THEN
    result := ertad.work_before_event_editing_command(sid, token, op, org, input);
    IF (result->'audit'->>'changed')::boolean THEN
      SELECT * INTO e FROM ertad.mobilization_events WHERE organization_id=org AND id=(result->'data'->>'id')::uuid;
      actor := ertad.review_identity(sid, token, true);
      INSERT INTO ertad.mobilization_event_history(organization_id, event_id, version, actor_id, action, note, details, created_at)
      VALUES(org, e.id, e.version, actor, 'complete', trim(COALESCE(input->>'note','')), jsonb_build_object(
        'linkedSummary', ertad.event_linked_summary(org, e.id)
      ), clock_timestamp())
      ON CONFLICT DO NOTHING;
    END IF;
    RETURN result;
  END IF;

  cascade_cancel := op = 'event_cancel' AND COALESCE((input->>'cancelLinkedTasks')::boolean, false);
  IF op = 'event_cancel' AND NOT cascade_cancel THEN
    result := ertad.work_before_event_editing_command(sid, token, op, org, input - 'cancelLinkedTasks');
    IF (result->'audit'->>'changed')::boolean THEN
      SELECT * INTO e FROM ertad.mobilization_events WHERE organization_id=org AND id=(result->'data'->>'id')::uuid;
      actor := ertad.review_identity(sid, token, true);
      INSERT INTO ertad.mobilization_event_history(organization_id, event_id, version, actor_id, action, note, details, created_at)
      VALUES(org, e.id, e.version, actor, 'cancel', trim(COALESCE(input->>'note','')), jsonb_build_object(
        'cancelledTasks', 0,
        'linkedSummary', ertad.event_linked_summary(org, e.id)
      ), clock_timestamp())
      ON CONFLICT DO NOTHING;
    END IF;
    RETURN result;
  END IF;

  actor := ertad.review_identity(sid, token, true);
  PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
  PERFORM pg_advisory_xact_lock(752991884322001::bigint);
  PERFORM ertad.review_identity(sid, token, true);

  SELECT * INTO e FROM ertad.mobilization_events WHERE organization_id=org AND id=(input->>'id')::uuid FOR UPDATE;
  IF NOT FOUND OR NOT ertad.event_visible(actor, e) OR NOT ertad.event_manager(actor, e) THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied';
  END IF;

  fp := encode(sha256(convert_to((input-'key')::text,'UTF8')),'hex');
  SELECT * INTO receipt FROM ertad.event_commands WHERE organization_id=org AND actor_id=actor AND key=(input->>'key')::uuid;
  IF FOUND THEN
    IF receipt.operation<>op OR receipt.fingerprint<>fp THEN
      RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Retry conflict';
    END IF;
    RETURN jsonb_build_object(
      'data', receipt.response,
      'audit', jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'eventId',receipt.event_id,'changed',false)
    );
  END IF;

  IF e.version IS DISTINCT FROM (input->>'version')::integer OR e.status<>'open' THEN
    RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Event changed or closed';
  END IF;

  IF op = 'event_edit' THEN
    IF input - ARRAY['organizationId','id','key','version','title','description','location','startsAt','endsAt','note'] <> '{}'::jsonb
    OR NOT input ?& ARRAY['title','description','location','startsAt','endsAt','note']
    OR jsonb_typeof(input->'title') IS DISTINCT FROM 'string' OR length(trim(input->>'title')) NOT BETWEEN 3 AND 160
    OR jsonb_typeof(input->'description') IS DISTINCT FROM 'string' OR length(input->>'description') > 3000
    OR jsonb_typeof(input->'location') IS DISTINCT FROM 'string' OR length(trim(input->>'location')) > 300
    OR jsonb_typeof(input->'startsAt') IS DISTINCT FROM 'string' OR jsonb_typeof(input->'endsAt') IS DISTINCT FROM 'string'
    OR jsonb_typeof(input->'note') IS DISTINCT FROM 'string' OR length(trim(input->>'note')) NOT BETWEEN 3 AND 1000 THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid event amendment';
    END IF;
    starts := (input->>'startsAt')::timestamptz;
    ends := (input->>'endsAt')::timestamptz;
    note_text := trim(input->>'note');
    IF NOT isfinite(starts) OR NOT isfinite(ends) OR ends <= starts
    OR (ends IS DISTINCT FROM e.ends_at AND (ends <= clock_timestamp() OR ends > clock_timestamp() + interval '365 days')) THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid event schedule';
    END IF;
    previous := e;
    UPDATE ertad.mobilization_events
    SET title=trim(input->>'title'), description=input->>'description', location=trim(input->>'location'),
        starts_at=starts, ends_at=ends, version=version+1
    WHERE organization_id=org AND id=e.id RETURNING * INTO e;
    IF ertad.event_snapshot(previous) = ertad.event_snapshot(e) THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='No event changes';
    END IF;
    INSERT INTO ertad.mobilization_event_history(organization_id, event_id, version, actor_id, action, note, details, created_at)
    VALUES(org, e.id, e.version, actor, 'edit', note_text, jsonb_build_object(
      'before', ertad.event_snapshot(previous),
      'after', ertad.event_snapshot(e),
      'linkedSummary', ertad.event_linked_summary(org, e.id)
    ), clock_timestamp());
    data := jsonb_build_object('id', e.id, 'version', e.version);
    INSERT INTO ertad.event_commands VALUES(org, actor, (input->>'key')::uuid, e.id, op, fp, data);
    RETURN jsonb_build_object(
      'data', data,
      'audit', jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'eventId',e.id,'changed',true,'endsChanged',ends IS DISTINCT FROM previous.ends_at)
    );
  END IF;

  -- Explicit cascade cancellation: cancel unverified open/offered linked tasks while keeping completed work & reward claims intact.
  note_text := trim(COALESCE(input->>'note',''));
  IF length(note_text) NOT BETWEEN 3 AND 1000 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Reason required';
  END IF;
  IF EXISTS(
    SELECT 1 FROM ertad.work_items w
    WHERE w.organization_id=org AND w.event_id=e.id AND w.status IN ('open','offered')
    AND (EXISTS(SELECT 1 FROM ertad.work_assignments a WHERE a.organization_id=org AND a.work_id=w.id AND a.status='verified')
      OR EXISTS(SELECT 1 FROM ertad.work_items c WHERE c.organization_id=org AND c.parent_id=w.id AND c.status='completed'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Complete verified linked work before cancelling event';
  END IF;

  FOR w_row IN
    SELECT * FROM ertad.work_items
    WHERE organization_id=org AND event_id=e.id AND status IN ('open','offered')
    ORDER BY array_length(scope_path,1) DESC, id
    FOR UPDATE
  LOOP
    UPDATE ertad.work_needs SET cancelled=true WHERE organization_id=org AND work_id=w_row.id AND NOT cancelled;
    UPDATE ertad.work_assignments SET status='withdrawn'
    WHERE organization_id=org AND work_id=w_row.id AND status IN ('applied','reserved','assigned','in_progress','submitted');
    UPDATE ertad.work_items SET status='cancelled', version=version+1 WHERE organization_id=org AND id=w_row.id RETURNING * INTO w_row;
    INSERT INTO ertad.work_events(organization_id, work_id, version, actor_id, action, note, details, created_at)
    VALUES(org, w_row.id, w_row.version, actor, 'cancel', note_text, jsonb_build_object('eventId', e.id), clock_timestamp());
    INSERT INTO ertad.work_notifications(organization_id, work_id, version, recipient_id)
    SELECT org, w_row.id, w_row.version, u.id
    FROM ertad.member_users u
    WHERE u.id<>actor AND u.status='active' AND ertad.work_visible(u.id, w_row)
    AND (u.id=w_row.creator_id OR ertad.review_has_scope(u.id, org, w_row.unit_id, 'workitem.create')
      OR ertad.review_has_scope(u.id, org, w_row.unit_id, 'workitem.verify')
      OR EXISTS(SELECT 1 FROM ertad.work_assignments a WHERE a.organization_id=org AND a.work_id=w_row.id AND a.user_id=u.id));
    cancelled_count := cancelled_count + 1;
  END LOOP;

  SELECT count(*)::integer INTO preserved_completed FROM ertad.work_items WHERE organization_id=org AND event_id=e.id AND status='completed';
  SELECT count(*)::integer INTO preserved_claims FROM ertad.event_participation_claims WHERE organization_id=org AND event_id=e.id;

  previous := e;
  UPDATE ertad.mobilization_events SET status='cancelled', version=version+1 WHERE organization_id=org AND id=e.id RETURNING * INTO e;
  INSERT INTO ertad.mobilization_event_history(organization_id, event_id, version, actor_id, action, note, details, created_at)
  VALUES(org, e.id, e.version, actor, 'cancel', note_text, jsonb_build_object(
    'before', ertad.event_snapshot(previous),
    'after', ertad.event_snapshot(e),
    'cancelledTasks', cancelled_count,
    'preservedCompletedTasks', preserved_completed,
    'preservedClaims', preserved_claims
  ), clock_timestamp());
  data := jsonb_build_object('id', e.id, 'version', e.version);
  INSERT INTO ertad.event_commands VALUES(org, actor, (input->>'key')::uuid, e.id, op, fp, data);
  RETURN jsonb_build_object(
    'data', data,
    'audit', jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'eventId',e.id,'changed',true,'cancelledTasks',cancelled_count)
  );
END $$;

ALTER FUNCTION ertad.work_finish(uuid, text, text, uuid, jsonb, boolean) RENAME TO work_before_event_editing_finish;
CREATE FUNCTION ertad.work_finish(sid uuid, token text, op text, org uuid, input jsonb, changed boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid; e ertad.mobilization_events; event uuid;
BEGIN
  IF op = 'event_edit' THEN
    actor := ertad.review_identity(sid, token, true);
    SELECT event_id INTO event FROM ertad.event_commands WHERE organization_id=org AND actor_id=actor AND key=(input->>'key')::uuid;
    SELECT * INTO e FROM ertad.mobilization_events WHERE organization_id=org AND id=event;
    IF NOT FOUND OR NOT ertad.event_manager(actor, e) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
    IF changed AND EXISTS(
      SELECT 1 FROM ertad.mobilization_event_history h
      WHERE h.organization_id=org AND h.event_id=e.id AND h.version=e.version AND h.action='edit'
      AND h.details->'before'->>'endsAt' IS DISTINCT FROM h.details->'after'->>'endsAt'
    ) AND e.ends_at <= clock_timestamp() THEN
      RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Event end passed during audit';
    END IF;
    RETURN;
  END IF;
  IF op = 'event_cancel' AND COALESCE((input->>'cancelLinkedTasks')::boolean, false) THEN
    actor := ertad.review_identity(sid, token, true);
    SELECT event_id INTO event FROM ertad.event_commands WHERE organization_id=org AND actor_id=actor AND key=(input->>'key')::uuid;
    SELECT * INTO e FROM ertad.mobilization_events WHERE organization_id=org AND id=event;
    IF NOT FOUND OR NOT ertad.event_manager(actor, e) OR e.status<>'cancelled'
    OR EXISTS(SELECT 1 FROM ertad.work_items w WHERE w.organization_id=org AND w.event_id=e.id AND w.status IN ('open','offered')) THEN
      RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Event cascade cancellation failed final check';
    END IF;
    RETURN;
  END IF;
  PERFORM ertad.work_before_event_editing_finish(sid, token, op, org, input, changed);
END $$;

REVOKE ALL ON FUNCTION ertad.event_snapshot(ertad.mobilization_events), ertad.event_linked_summary(uuid, uuid),
  ertad.work_before_event_editing_command(uuid, text, text, uuid, jsonb),
  ertad.work_before_event_editing_finish(uuid, text, text, uuid, jsonb, boolean) FROM PUBLIC, ertad_app;
REVOKE ALL ON FUNCTION ertad.work_command(uuid, text, text, uuid, jsonb), ertad.work_finish(uuid, text, text, uuid, jsonb, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.work_command(uuid, text, text, uuid, jsonb), ertad.work_finish(uuid, text, text, uuid, jsonb, boolean) TO ertad_app;

