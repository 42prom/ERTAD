-- Restore option-based elections and survey presentation metadata.
-- Reuse scoped commands, frozen definitions, immutable named votes and audit.
CREATE OR REPLACE FUNCTION ertad.decision_definition_valid(kind text,opts text[],threshold integer,questions jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE q jsonb; seen uuid[]:='{}'; qid uuid; qopts text[]; allowed text[];
BEGIN
 IF kind IN ('poll','election') THEN RETURN threshold IS NULL AND questions IS NULL AND ertad.decision_options_valid(opts); END IF;
 IF kind='referendum' THEN RETURN COALESCE(threshold BETWEEN 50 AND 100 AND questions IS NULL AND opts=ARRAY['Yes','No','Abstain'],false); END IF;
 IF kind<>'survey' OR threshold IS NOT NULL OR cardinality(opts)<>0 OR jsonb_typeof(questions) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(questions) NOT BETWEEN 1 AND 20 THEN RETURN false; END IF;
 FOR q IN SELECT value FROM jsonb_array_elements(questions) LOOP
  IF jsonb_typeof(q) IS DISTINCT FROM 'object' OR jsonb_typeof(q->'id') IS DISTINCT FROM 'string' OR jsonb_typeof(q->'title') IS DISTINCT FROM 'string'
   OR length(trim(q->>'title')) NOT BETWEEN 3 AND 300 OR jsonb_typeof(q->'required') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
  qid:=(q->>'id')::uuid;
  IF qid=ANY(seen) THEN RETURN false; END IF; seen:=array_append(seen,qid);
  allowed:=ARRAY['id','title','type','required'];
  IF q->>'type' IN ('single_choice','multiple_choice','ranked_choice') THEN
   allowed:=allowed||ARRAY['options'];
   IF jsonb_typeof(q->'options') IS DISTINCT FROM 'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(q->'options') v WHERE jsonb_typeof(v) IS DISTINCT FROM 'string') THEN RETURN false; END IF;
   SELECT array_agg(value) INTO qopts FROM jsonb_array_elements_text(q->'options');
   IF NOT ertad.decision_options_valid(qopts) THEN RETURN false; END IF;
  ELSIF q->>'type'='text' THEN
   allowed:=allowed||ARRAY['maxLength','placeholder'];
   IF q ? 'placeholder' AND (jsonb_typeof(q->'placeholder') IS DISTINCT FROM 'string' OR length(trim(q->>'placeholder'))>200) THEN RETURN false; END IF;
   IF jsonb_typeof(q->'maxLength') IS DISTINCT FROM 'number' OR (q->>'maxLength')::numeric<>trunc((q->>'maxLength')::numeric) OR (q->>'maxLength')::integer NOT BETWEEN 1 AND 2000 THEN RETURN false; END IF;
  ELSIF q->>'type'='rating_scale' THEN
   allowed:=allowed||ARRAY['min','max','minLabel','maxLabel'];
   IF q ? 'minLabel' AND (jsonb_typeof(q->'minLabel') IS DISTINCT FROM 'string' OR length(trim(q->>'minLabel'))>120) THEN RETURN false; END IF;
   IF q ? 'maxLabel' AND (jsonb_typeof(q->'maxLabel') IS DISTINCT FROM 'string' OR length(trim(q->>'maxLabel'))>120) THEN RETURN false; END IF;
   IF jsonb_typeof(q->'min') IS DISTINCT FROM 'number' OR jsonb_typeof(q->'max') IS DISTINCT FROM 'number'
    OR (q->>'min')::numeric<>trunc((q->>'min')::numeric) OR (q->>'max')::numeric<>trunc((q->>'max')::numeric)
    OR (q->>'min')::integer NOT BETWEEN 0 AND 9 OR (q->>'max')::integer NOT BETWEEN 1 AND 10 OR (q->>'min')::integer >= (q->>'max')::integer THEN RETURN false; END IF;
  ELSE RETURN false; END IF;
  IF q-allowed<>'{}'::jsonb THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END; $$;

REVOKE ALL ON FUNCTION ertad.decision_definition_valid(text,text[],integer,jsonb) FROM PUBLIC;
