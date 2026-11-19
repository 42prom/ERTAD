-- Platform Wave 4: multi-process persistent bounded security telemetry (up to 24h)
-- and tamper-evident immutable audit hash-chain verification reader.

CREATE TABLE ertad.security_telemetry_buckets (
  bucket_minute timestamptz NOT NULL,
  signal text NOT NULL CHECK (
    signal IN (
      'login_failed',
      'step_up_failed',
      'authentication_required',
      'access_denied',
      'rate_limited',
      'server_error'
    )
  ),
  count bigint NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (bucket_minute, signal)
);

CREATE INDEX security_telemetry_buckets_time_idx
  ON ertad.security_telemetry_buckets (bucket_minute DESC);

REVOKE ALL ON ertad.security_telemetry_buckets FROM PUBLIC, ertad_app;

CREATE FUNCTION ertad.record_security_telemetry(
  bucket_ts timestamptz,
  signal_counts jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  b_min timestamptz := date_trunc('minute', bucket_ts);
  sig text;
  delta bigint;
BEGIN
  IF b_min IS NULL OR jsonb_typeof(signal_counts) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid telemetry payload';
  END IF;
  FOR sig IN SELECT unnest(ARRAY[
    'login_failed', 'step_up_failed', 'authentication_required', 'access_denied', 'rate_limited', 'server_error'
  ]) LOOP
    delta := COALESCE((signal_counts->>sig)::bigint, 0);
    IF delta > 0 THEN
      INSERT INTO ertad.security_telemetry_buckets (bucket_minute, signal, count)
      VALUES (b_min, sig, delta)
      ON CONFLICT (bucket_minute, signal) DO UPDATE
        SET count = LEAST(9223372036854775807::bigint, ertad.security_telemetry_buckets.count + EXCLUDED.count);
    END IF;
  END LOOP;
  DELETE FROM ertad.security_telemetry_buckets
   WHERE bucket_minute < clock_timestamp() - interval '72 hours';
END;
$$;

CREATE FUNCTION ertad.read_security_telemetry(
  sid uuid,
  token text,
  window_minutes integer,
  category text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  account uuid;
  capabilities text[];
  first_bucket timestamptz;
BEGIN
  IF window_minutes NOT IN (15, 60, 1440)
     OR category NOT IN (
       'all', 'login_failed', 'step_up_failed', 'authentication_required', 'access_denied', 'rate_limited', 'server_error'
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid telemetry filter';
  END IF;
  SELECT p.admin_user_id, p.permissions INTO account, capabilities
  FROM ertad.admin_sessions s
  JOIN ertad.admin_users u ON u.id = s.admin_user_id
  JOIN ertad.platform_accounts p ON p.admin_user_id = u.id
  WHERE s.id = sid
    AND s.token_hash = token
    AND s.revoked_at IS NULL
    AND s.idle_expires_at > clock_timestamp()
    AND s.absolute_expires_at > clock_timestamp()
    AND u.is_active
    AND (u.locked_until IS NULL OR u.locked_until <= clock_timestamp())
    AND p.valid_until > clock_timestamp();
  IF NOT FOUND OR NOT COALESCE('platform.audit.read' = ANY(capabilities), false) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
  END IF;

  first_bucket := date_trunc('minute', clock_timestamp()) - make_interval(mins => window_minutes - 1);

  RETURN jsonb_build_object(
    'windowMinutes', window_minutes,
    'category', category,
    'retention', 'persisted_database_72_hours',
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'at', t.bucket_minute,
        'counts', jsonb_build_object(
          'login_failed', t.login_failed,
          'step_up_failed', t.step_up_failed,
          'authentication_required', t.authentication_required,
          'access_denied', t.access_denied,
          'rate_limited', t.rate_limited,
          'server_error', t.server_error
        )
      ) ORDER BY t.bucket_minute DESC)
      FROM (
        SELECT
          b.bucket_minute,
          COALESCE(SUM(b.count) FILTER (WHERE b.signal = 'login_failed'), 0) AS login_failed,
          COALESCE(SUM(b.count) FILTER (WHERE b.signal = 'step_up_failed'), 0) AS step_up_failed,
          COALESCE(SUM(b.count) FILTER (WHERE b.signal = 'authentication_required'), 0) AS authentication_required,
          COALESCE(SUM(b.count) FILTER (WHERE b.signal = 'access_denied'), 0) AS access_denied,
          COALESCE(SUM(b.count) FILTER (WHERE b.signal = 'rate_limited'), 0) AS rate_limited,
          COALESCE(SUM(b.count) FILTER (WHERE b.signal = 'server_error'), 0) AS server_error
        FROM ertad.security_telemetry_buckets b
        WHERE b.bucket_minute >= first_bucket
          AND (category = 'all' OR b.signal = category)
        GROUP BY b.bucket_minute
      ) t
    ), '[]'::jsonb)
  );
END;
$$;

CREATE FUNCTION ertad.read_audit_chain_slice(
  sid uuid,
  token text,
  after_id bigint,
  max_rows integer DEFAULT 2000
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  account uuid;
  capabilities text[];
  clamped integer := LEAST(GREATEST(COALESCE(max_rows, 2000), 1), 5000);
  rows_json jsonb;
  prev_row jsonb := NULL;
BEGIN
  SELECT p.permissions INTO capabilities
  FROM ertad.admin_sessions s
  JOIN ertad.admin_users u ON u.id = s.admin_user_id
  JOIN ertad.platform_accounts p ON p.admin_user_id = u.id
  WHERE s.id = sid
    AND s.token_hash = token
    AND s.revoked_at IS NULL
    AND s.idle_expires_at > clock_timestamp()
    AND s.absolute_expires_at > clock_timestamp()
    AND u.is_active
    AND (u.locked_until IS NULL OR u.locked_until <= clock_timestamp())
    AND p.valid_until > clock_timestamp();
  IF NOT FOUND OR NOT COALESCE('platform.audit.read' = ANY(capabilities), false) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
  END IF;

  IF after_id IS NOT NULL AND after_id > 0 THEN
    SELECT jsonb_build_object('id', a.id::text, 'rowHash', a.row_hash) INTO prev_row
    FROM ertad.audit_log a
    WHERE a.id <= after_id
    ORDER BY a.id DESC
    LIMIT 1;
  END IF;

  SELECT COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', s.id::text,
      'eventType', s.event_type,
      'payload', s.payload,
      'previousHash', s.previous_hash,
      'rowHash', s.row_hash,
      'createdAt', s.created_at
    ) ORDER BY s.id ASC)
    FROM (
      SELECT id, event_type, payload, previous_hash, row_hash, created_at
      FROM ertad.audit_log
      WHERE id > COALESCE(after_id, 0)
      ORDER BY id ASC
      LIMIT clamped
    ) s
  ), '[]'::jsonb) INTO rows_json;

  RETURN jsonb_build_object(
    'previous', prev_row,
    'rows', rows_json
  );
END;
$$;

REVOKE ALL ON FUNCTION
  ertad.record_security_telemetry(timestamptz, jsonb),
  ertad.read_security_telemetry(uuid, text, integer, text),
  ertad.read_audit_chain_slice(uuid, text, bigint, integer)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  ertad.record_security_telemetry(timestamptz, jsonb),
  ertad.read_security_telemetry(uuid, text, integer, text),
  ertad.read_audit_chain_slice(uuid, text, bigint, integer)
TO ertad_app;
