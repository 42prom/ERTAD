-- Decisions Wave 3: conditional survey branching (visibleIf) and cryptographically
-- unlinkable anonymous ballot verification receipt digests.

ALTER TABLE ertad.decision_anonymous_ballots
  ADD COLUMN receipt_digest text
  CHECK (receipt_digest IS NULL OR receipt_digest ~ '^[0-9a-f]{16}$');

CREATE FUNCTION ertad.assign_anonymous_ballot_receipt() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.receipt_digest IS NULL THEN
    NEW.receipt_digest := substr(
      encode(
        sha256(
          convert_to(
            NEW.decision_id::text || ':' || gen_random_uuid()::text || ':' || clock_timestamp()::text,
            'UTF8'
          )
        ),
        'hex'
      ),
      1,
      16
    );
  END IF;
  PERFORM set_config('ertad.anonymous_receipt_digest', NEW.receipt_digest, true);
  RETURN NEW;
END;
$$;

CREATE TRIGGER assign_anonymous_ballot_receipt_trg
  BEFORE INSERT ON ertad.decision_anonymous_ballots
  FOR EACH ROW EXECUTE FUNCTION ertad.assign_anonymous_ballot_receipt();

CREATE OR REPLACE FUNCTION ertad.decision_definition_valid(
  kind text,
  opts text[],
  threshold integer,
  questions jsonb
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  q jsonb;
  seen uuid[] := '{}';
  qid uuid;
  ref_qid uuid;
  qopts text[];
  allowed text[];
  cond jsonb;
BEGIN
  IF kind IN ('poll', 'election') THEN
    RETURN threshold IS NULL AND questions IS NULL AND ertad.decision_options_valid(opts);
  END IF;
  IF kind = 'referendum' THEN
    RETURN COALESCE(threshold BETWEEN 50 AND 100 AND questions IS NULL AND opts = ARRAY['Yes', 'No', 'Abstain'], false);
  END IF;
  IF kind <> 'survey' OR threshold IS NOT NULL OR cardinality(opts) <> 0 OR jsonb_typeof(questions) IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;
  IF jsonb_array_length(questions) NOT BETWEEN 1 AND 20 THEN
    RETURN false;
  END IF;
  FOR q IN SELECT value FROM jsonb_array_elements(questions) LOOP
    IF jsonb_typeof(q) IS DISTINCT FROM 'object'
       OR jsonb_typeof(q->'id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(q->'title') IS DISTINCT FROM 'string'
       OR length(trim(q->>'title')) NOT BETWEEN 3 AND 300
       OR jsonb_typeof(q->'required') IS DISTINCT FROM 'boolean' THEN
      RETURN false;
    END IF;
    qid := (q->>'id')::uuid;
    IF qid = ANY(seen) THEN
      RETURN false;
    END IF;
    allowed := ARRAY['id', 'title', 'type', 'required'];
    IF q ? 'visibleIf' AND q->'visibleIf' IS NOT NULL THEN
      allowed := allowed || ARRAY['visibleIf'];
      cond := q->'visibleIf';
      IF jsonb_typeof(cond) IS DISTINCT FROM 'object'
         OR (cond - ARRAY['questionId', 'equals']) <> '{}'::jsonb
         OR NOT (cond ?& ARRAY['questionId', 'equals'])
         OR jsonb_typeof(cond->'questionId') IS DISTINCT FROM 'string'
         OR jsonb_typeof(cond->'equals') IS DISTINCT FROM 'string'
         OR length(trim(cond->>'equals')) NOT BETWEEN 1 AND 160 THEN
        RETURN false;
      END IF;
      ref_qid := (cond->>'questionId')::uuid;
      IF NOT (ref_qid = ANY(seen)) THEN
        RETURN false;
      END IF;
    END IF;
    seen := array_append(seen, qid);
    IF q->>'type' IN ('single_choice', 'multiple_choice', 'ranked_choice') THEN
      allowed := allowed || ARRAY['options'];
      IF jsonb_typeof(q->'options') IS DISTINCT FROM 'array'
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(q->'options') v WHERE jsonb_typeof(v) IS DISTINCT FROM 'string') THEN
        RETURN false;
      END IF;
      SELECT array_agg(value) INTO qopts FROM jsonb_array_elements_text(q->'options');
      IF NOT ertad.decision_options_valid(qopts) THEN
        RETURN false;
      END IF;
    ELSIF q->>'type' = 'text' THEN
      allowed := allowed || ARRAY['maxLength', 'placeholder'];
      IF q ? 'placeholder'
         AND (jsonb_typeof(q->'placeholder') IS DISTINCT FROM 'string' OR length(trim(q->>'placeholder')) > 200) THEN
        RETURN false;
      END IF;
      IF jsonb_typeof(q->'maxLength') IS DISTINCT FROM 'number'
         OR (q->>'maxLength')::numeric <> trunc((q->>'maxLength')::numeric)
         OR (q->>'maxLength')::integer NOT BETWEEN 1 AND 2000 THEN
        RETURN false;
      END IF;
    ELSIF q->>'type' = 'rating_scale' THEN
      allowed := allowed || ARRAY['min', 'max', 'minLabel', 'maxLabel'];
      IF q ? 'minLabel'
         AND (jsonb_typeof(q->'minLabel') IS DISTINCT FROM 'string' OR length(trim(q->>'minLabel')) > 120) THEN
        RETURN false;
      END IF;
      IF q ? 'maxLabel'
         AND (jsonb_typeof(q->'maxLabel') IS DISTINCT FROM 'string' OR length(trim(q->>'maxLabel')) > 120) THEN
        RETURN false;
      END IF;
      IF jsonb_typeof(q->'min') IS DISTINCT FROM 'number'
         OR jsonb_typeof(q->'max') IS DISTINCT FROM 'number'
         OR (q->>'min')::numeric <> trunc((q->>'min')::numeric)
         OR (q->>'max')::numeric <> trunc((q->>'max')::numeric)
         OR (q->>'min')::integer NOT BETWEEN 0 AND 9
         OR (q->>'max')::integer NOT BETWEEN 1 AND 10
         OR (q->>'min')::integer >= (q->>'max')::integer THEN
        RETURN false;
      END IF;
    ELSE
      RETURN false;
    END IF;
    IF q - allowed <> '{}'::jsonb THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION ertad.decision_question_visible(q jsonb, answers jsonb) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  cond jsonb := q->'visibleIf';
  target_val jsonb;
  eq_text text;
BEGIN
  IF cond IS NULL OR jsonb_typeof(cond) IS DISTINCT FROM 'object' THEN
    RETURN true;
  END IF;
  target_val := answers->(cond->>'questionId');
  IF target_val IS NULL THEN
    RETURN false;
  END IF;
  eq_text := cond->>'equals';
  IF jsonb_typeof(target_val) = 'array' THEN
    RETURN eq_text ~ '^[0-9]+$' AND (target_val @> to_jsonb(eq_text::integer));
  END IF;
  RETURN (answers->>(cond->>'questionId')) = eq_text;
END;
$$;

CREATE OR REPLACE FUNCTION ertad.decision_answers_valid(questions jsonb, answers jsonb) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  q jsonb;
  a jsonb;
  v jsonb;
  count_options integer;
  q_visible boolean;
BEGIN
  IF jsonb_typeof(answers) IS DISTINCT FROM 'object' OR answers = '{}'::jsonb THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(answers) k
    WHERE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(questions) definition_question
      WHERE definition_question->>'id' = k
    )
  ) THEN
    RETURN false;
  END IF;
  FOR q IN SELECT value FROM jsonb_array_elements(questions) LOOP
    a := answers->(q->>'id');
    q_visible := ertad.decision_question_visible(q, answers);
    IF NOT q_visible THEN
      IF a IS NOT NULL THEN
        RETURN false;
      END IF;
      CONTINUE;
    END IF;
    IF a IS NULL THEN
      IF (q->>'required')::boolean THEN
        RETURN false;
      ELSE
        CONTINUE;
      END IF;
    END IF;
    IF q->>'type' = 'text' THEN
      IF jsonb_typeof(a) IS DISTINCT FROM 'string' OR length(trim(a#>>'{}')) NOT BETWEEN 1 AND (q->>'maxLength')::integer THEN
        RETURN false;
      END IF;
    ELSIF q->>'type' IN ('single_choice', 'rating_scale') THEN
      IF jsonb_typeof(a) IS DISTINCT FROM 'number' OR (a#>>'{}')::numeric <> trunc((a#>>'{}')::numeric) THEN
        RETURN false;
      END IF;
      IF q->>'type' = 'single_choice' AND (a#>>'{}')::integer NOT BETWEEN 0 AND jsonb_array_length(q->'options') - 1 THEN
        RETURN false;
      END IF;
      IF q->>'type' = 'rating_scale' AND (a#>>'{}')::integer NOT BETWEEN (q->>'min')::integer AND (q->>'max')::integer THEN
        RETURN false;
      END IF;
    ELSE
      count_options := jsonb_array_length(q->'options');
      IF jsonb_typeof(a) IS DISTINCT FROM 'array' THEN
        RETURN false;
      END IF;
      IF jsonb_array_length(a) NOT BETWEEN 1 AND count_options
         OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(a)) <> jsonb_array_length(a) THEN
        RETURN false;
      END IF;
      IF q->>'type' = 'ranked_choice' AND jsonb_array_length(a) <> count_options THEN
        RETURN false;
      END IF;
      FOR v IN SELECT value FROM jsonb_array_elements(a) LOOP
        IF jsonb_typeof(v) IS DISTINCT FROM 'number'
           OR (v#>>'{}')::numeric <> trunc((v#>>'{}')::numeric)
           OR (v#>>'{}')::integer NOT BETWEEN 0 AND count_options - 1 THEN
          RETURN false;
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN false;
END;
$$;

ALTER FUNCTION ertad.decision_view(uuid, ertad.decisions)
  RENAME TO decision_before_receipt_view;

CREATE FUNCTION ertad.decision_view(actor uuid, d ertad.decisions) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v jsonb;
BEGIN
  v := ertad.decision_before_receipt_view(actor, d);
  IF d.privacy = 'anonymous'
     AND (v->>'status') = 'closed'
     AND NOT COALESCE((v->>'resultsSuppressed')::boolean, false) THEN
    v := v || jsonb_build_object(
      'receiptDigests', COALESCE((
        SELECT jsonb_agg(b.receipt_digest ORDER BY b.receipt_digest)
        FROM ertad.decision_anonymous_ballots b
        WHERE b.organization_id = d.organization_id
          AND b.decision_id = d.id
          AND b.receipt_digest IS NOT NULL
      ), '[]'::jsonb)
    );
  END IF;
  RETURN v;
END;
$$;

ALTER FUNCTION ertad.decision_command(uuid, text, text, uuid, jsonb)
  RENAME TO decision_before_receipt_command;

CREATE FUNCTION ertad.decision_command(sid uuid, token text, op text, org uuid, input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  res jsonb;
  local_receipt text;
BEGIN
  PERFORM set_config('ertad.anonymous_receipt_digest', '', true);
  res := ertad.decision_before_receipt_command(sid, token, op, org, input);
  local_receipt := nullif(current_setting('ertad.anonymous_receipt_digest', true), '');
  PERFORM set_config('ertad.anonymous_receipt_digest', '', true);
  IF op = 'vote' AND COALESCE((res->'audit'->>'changed')::boolean, false) AND local_receipt IS NOT NULL THEN
    res := jsonb_set(res, '{data,receiptDigest}', to_jsonb(local_receipt));
  END IF;
  RETURN res;
END;
$$;

REVOKE ALL ON FUNCTION ertad.assign_anonymous_ballot_receipt(),
  ertad.decision_question_visible(jsonb, jsonb),
  ertad.decision_before_receipt_view(uuid, ertad.decisions),
  ertad.decision_before_receipt_command(uuid, text, text, uuid, jsonb),
  ertad.decision_view(uuid, ertad.decisions) FROM PUBLIC, ertad_app;
REVOKE ALL ON FUNCTION ertad.decision_command(uuid, text, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.decision_command(uuid, text, text, uuid, jsonb) TO ertad_app;

