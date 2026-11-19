-- Preserve existing named polls; add explicit referendum and survey definitions.
ALTER TABLE ertad.decisions ADD COLUMN kind text NOT NULL DEFAULT 'poll';
ALTER TABLE ertad.decisions ADD COLUMN threshold integer;
ALTER TABLE ertad.decisions ADD COLUMN questions jsonb;
ALTER TABLE ertad.decisions DROP CONSTRAINT decisions_options_check;

CREATE FUNCTION ertad.decision_options_valid(opts text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(cardinality(opts) BETWEEN 2 AND 8
 AND NOT EXISTS(SELECT 1 FROM unnest(opts) o WHERE o IS NULL OR length(trim(o)) NOT BETWEEN 1 AND 160)
 AND (SELECT count(DISTINCT lower(trim(o))) FROM unnest(opts) o)=cardinality(opts),false);
$$;
CREATE FUNCTION ertad.decision_definition_valid(kind text,opts text[],threshold integer,questions jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE q jsonb; seen uuid[]:='{}'; qid uuid; qopts text[]; allowed text[];
BEGIN
 IF kind='poll' THEN RETURN threshold IS NULL AND questions IS NULL AND ertad.decision_options_valid(opts); END IF;
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
   allowed:=allowed||ARRAY['maxLength'];
   IF jsonb_typeof(q->'maxLength') IS DISTINCT FROM 'number' OR (q->>'maxLength')::numeric<>trunc((q->>'maxLength')::numeric) OR (q->>'maxLength')::integer NOT BETWEEN 1 AND 2000 THEN RETURN false; END IF;
  ELSIF q->>'type'='rating_scale' THEN
   allowed:=allowed||ARRAY['min','max'];
   IF jsonb_typeof(q->'min') IS DISTINCT FROM 'number' OR jsonb_typeof(q->'max') IS DISTINCT FROM 'number'
    OR (q->>'min')::numeric<>trunc((q->>'min')::numeric) OR (q->>'max')::numeric<>trunc((q->>'max')::numeric)
    OR (q->>'min')::integer NOT BETWEEN 0 AND 9 OR (q->>'max')::integer NOT BETWEEN 1 AND 10 OR (q->>'min')::integer >= (q->>'max')::integer THEN RETURN false; END IF;
  ELSE RETURN false; END IF;
  IF q-allowed<>'{}'::jsonb THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END; $$;
ALTER TABLE ertad.decisions ADD CONSTRAINT decisions_definition_check CHECK(ertad.decision_definition_valid(kind,options,threshold,questions));

CREATE TABLE ertad.decision_survey_responses (
 organization_id uuid NOT NULL, decision_id uuid NOT NULL, user_id uuid NOT NULL, answers jsonb NOT NULL CHECK(jsonb_typeof(answers)='object'),
 PRIMARY KEY(organization_id,decision_id,user_id),
 FOREIGN KEY(organization_id,decision_id,user_id) REFERENCES ertad.decision_electorate(organization_id,decision_id,user_id)
);
CREATE TRIGGER immutable_survey_responses BEFORE UPDATE OR DELETE ON ertad.decision_survey_responses FOR EACH ROW EXECUTE FUNCTION ertad.prevent_audit_log_mutation();
CREATE TRIGGER no_truncate_survey_responses BEFORE TRUNCATE ON ertad.decision_survey_responses FOR EACH STATEMENT EXECUTE FUNCTION ertad.prevent_audit_log_mutation();

CREATE FUNCTION ertad.decision_answers_valid(questions jsonb,answers jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE q jsonb; a jsonb; v jsonb; count_options integer;
BEGIN
 IF jsonb_typeof(answers) IS DISTINCT FROM 'object' OR answers='{}'::jsonb THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(answers) k WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(questions) definition_question WHERE definition_question->>'id'=k)) THEN RETURN false; END IF;
 FOR q IN SELECT value FROM jsonb_array_elements(questions) LOOP
  a:=answers->(q->>'id');
  IF a IS NULL THEN IF (q->>'required')::boolean THEN RETURN false; ELSE CONTINUE; END IF; END IF;
  IF q->>'type'='text' THEN
   IF jsonb_typeof(a) IS DISTINCT FROM 'string' OR length(trim(a#>>'{}')) NOT BETWEEN 1 AND (q->>'maxLength')::integer THEN RETURN false; END IF;
  ELSIF q->>'type' IN ('single_choice','rating_scale') THEN
   IF jsonb_typeof(a) IS DISTINCT FROM 'number' OR (a#>>'{}')::numeric<>trunc((a#>>'{}')::numeric) THEN RETURN false; END IF;
   IF q->>'type'='single_choice' AND (a#>>'{}')::integer NOT BETWEEN 0 AND jsonb_array_length(q->'options')-1 THEN RETURN false; END IF;
   IF q->>'type'='rating_scale' AND (a#>>'{}')::integer NOT BETWEEN (q->>'min')::integer AND (q->>'max')::integer THEN RETURN false; END IF;
  ELSE
   count_options:=jsonb_array_length(q->'options');
   IF jsonb_typeof(a) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
   IF jsonb_array_length(a) NOT BETWEEN 1 AND count_options OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(a))<>jsonb_array_length(a) THEN RETURN false; END IF;
   IF q->>'type'='ranked_choice' AND jsonb_array_length(a)<>count_options THEN RETURN false; END IF;
   FOR v IN SELECT value FROM jsonb_array_elements(a) LOOP
    IF jsonb_typeof(v) IS DISTINCT FROM 'number' OR (v#>>'{}')::numeric<>trunc((v#>>'{}')::numeric) OR (v#>>'{}')::integer NOT BETWEEN 0 AND count_options-1 THEN RETURN false; END IF;
   END LOOP;
  END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END; $$;

CREATE FUNCTION ertad.decision_survey_results(actor uuid,d ertad.decisions) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE q jsonb; r jsonb; results jsonb:='[]'; counts jsonb; answered integer;
BEGIN
 FOR q IN SELECT value FROM jsonb_array_elements(d.questions) LOOP
  SELECT count(*) INTO answered FROM ertad.decision_survey_responses WHERE organization_id=d.organization_id AND decision_id=d.id AND answers ? (q->>'id');
  r:=jsonb_build_object('id',q->>'id','title',q->>'title','type',q->>'type','answered',answered);
  IF q->>'type'='text' THEN
   IF ertad.review_has_scope(actor,d.organization_id,d.unit_id,'decision.manage') THEN
    SELECT COALESCE(jsonb_agg(answer ORDER BY answer),'[]') INTO counts FROM (SELECT answers->>(q->>'id') AS answer FROM ertad.decision_survey_responses WHERE organization_id=d.organization_id AND decision_id=d.id AND answers ? (q->>'id') ORDER BY answers->>(q->>'id') LIMIT 25) texts;
    r:=r||jsonb_build_object('texts',counts,'truncated',answered>25);
   END IF;
  ELSIF q->>'type'='rating_scale' THEN
   SELECT jsonb_agg(jsonb_build_object('label',n::text,'votes',(SELECT count(*) FROM ertad.decision_survey_responses WHERE organization_id=d.organization_id AND decision_id=d.id AND answers->(q->>'id')=to_jsonb(n))) ORDER BY n) INTO counts FROM generate_series((q->>'min')::integer,(q->>'max')::integer) n;
   r:=r||jsonb_build_object('results',counts,'average',(SELECT round(avg((answers->>(q->>'id'))::numeric),2) FROM ertad.decision_survey_responses WHERE organization_id=d.organization_id AND decision_id=d.id AND answers ? (q->>'id')));
  ELSE
   SELECT jsonb_agg(jsonb_build_object('label',o.label,'votes',COALESCE((SELECT sum(CASE
    WHEN q->>'type'='single_choice' THEN CASE WHEN s.answers->(q->>'id')=to_jsonb(o.n-1) THEN 1 ELSE 0 END
    WHEN q->>'type'='multiple_choice' THEN CASE WHEN s.answers->(q->>'id') @> to_jsonb(o.n-1) THEN 1 ELSE 0 END
    ELSE (SELECT jsonb_array_length(q->'options')+1-position FROM jsonb_array_elements(s.answers->(q->>'id')) WITH ORDINALITY a(value,position) WHERE a.value=to_jsonb(o.n-1)) END)
    FROM ertad.decision_survey_responses s WHERE s.organization_id=d.organization_id AND s.decision_id=d.id AND s.answers ? (q->>'id')),0)) ORDER BY o.n)
    INTO counts FROM jsonb_array_elements_text(q->'options') WITH ORDINALITY o(label,n);
   r:=r||jsonb_build_object('results',counts);
  END IF;
  results:=results||jsonb_build_array(r);
 END LOOP;
 RETURN results;
END; $$;

CREATE OR REPLACE FUNCTION ertad.decision_view(actor uuid,d ertad.decisions) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE finished boolean; eligible boolean; voted boolean; total integer; counts jsonb; result jsonb; participation integer; yes_count integer; no_count integer; outcome text;
BEGIN
 finished:=d.status='closed' OR (d.status='open' AND d.closes_at<=clock_timestamp());
 eligible:=EXISTS(SELECT 1 FROM ertad.decision_electorate e WHERE e.organization_id=d.organization_id AND e.decision_id=d.id AND e.user_id=actor
   AND ertad.decision_eligible(actor,d.organization_id,d.unit_id,e.membership_id));
 voted:=EXISTS(SELECT 1 FROM ertad.decision_named_votes v WHERE v.organization_id=d.organization_id AND v.decision_id=d.id AND v.user_id=actor);
 IF d.kind='survey' THEN voted:=EXISTS(SELECT 1 FROM ertad.decision_survey_responses WHERE organization_id=d.organization_id AND decision_id=d.id AND user_id=actor); END IF;
 SELECT count(*) INTO total FROM ertad.decision_electorate WHERE organization_id=d.organization_id AND decision_id=d.id;
 result:=jsonb_build_object('id',d.id,'unitId',d.unit_id,'unitName',(SELECT name FROM ertad.units WHERE organization_id=d.organization_id AND id=d.unit_id),
 'kind',d.kind,'threshold',d.threshold,'questions',d.questions,'title',d.title,'description',d.description,'options',d.options,'privacy',d.privacy,'version',d.version,'quorum',d.quorum,
 'status',CASE WHEN finished THEN 'closed' ELSE d.status END,'closesAt',d.closes_at,'electorate',total,'voted',voted,
 'canManage',ertad.review_has_scope(actor,d.organization_id,d.unit_id,'decision.manage'),
 'canPublish',ertad.review_has_scope(actor,d.organization_id,d.unit_id,'decision.publish'),
 'canVote',eligible AND NOT voted AND d.status='open' AND NOT finished AND d.scope_path=ertad.unit_path(d.organization_id,d.unit_id));
 IF finished AND d.kind='survey' THEN
  RETURN result||jsonb_build_object('surveyResults',ertad.decision_survey_results(actor,d),'participation',(SELECT count(*) FROM ertad.decision_survey_responses WHERE organization_id=d.organization_id AND decision_id=d.id));
 END IF;
 IF finished THEN
   SELECT jsonb_agg(jsonb_build_object('label',o.label,'votes',(SELECT count(*) FROM ertad.decision_named_votes v
    WHERE v.organization_id=d.organization_id AND v.decision_id=d.id AND v.choice=o.n-1)) ORDER BY o.n)
   INTO counts FROM unnest(d.options) WITH ORDINALITY o(label,n);
   result:=result||jsonb_build_object('results',counts,'participation',(SELECT count(*) FROM ertad.decision_named_votes WHERE organization_id=d.organization_id AND decision_id=d.id));
  IF d.kind='referendum' THEN
   participation:=(result->>'participation')::integer;
   yes_count:=(counts->0->>'votes')::integer; no_count:=(counts->1->>'votes')::integer;
   outcome:=CASE WHEN participation*100<total*d.quorum THEN 'inquorate'
    WHEN yes_count+no_count=0 THEN 'no_decision' WHEN yes_count=no_count THEN 'tie'
    WHEN yes_count>no_count AND yes_count*100 >= (yes_count+no_count)*d.threshold THEN 'accepted' ELSE 'rejected' END;
   result:=result||jsonb_build_object('outcome',outcome);
  END IF;
 END IF;
 RETURN result;
END; $$;

CREATE OR REPLACE FUNCTION ertad.decision_command(sid uuid,token text,op text,org uuid,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_column
DECLARE actor uuid; d ertad.decisions; receipt ertad.decision_commands; result jsonb; changed boolean:=false;
 mutation boolean; permission text; opts text[]; target uuid; n integer; view_name text; payload jsonb; chosen integer;
BEGIN
 IF op NOT IN ('contexts','audiences','list','detail','create','update','publish','close','cancel','vote') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid operation'; END IF;
 mutation:=op IN ('create','update','publish','close','cancel','vote');
 actor:=ertad.review_identity(sid,token,mutation);
 IF op='contexts' THEN
  PERFORM 1 FROM ertad.organizations o WHERE EXISTS(SELECT 1 FROM ertad.memberships m WHERE m.organization_id=o.id AND m.user_id=actor) ORDER BY o.id FOR SHARE;
 ELSIF mutation THEN
  PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 ELSE
  PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 END IF;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint);
 PERFORM ertad.review_identity(sid,token,mutation);
 IF op='contexts' THEN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',o.id,'name',o.name) ORDER BY o.name,o.id),'[]') INTO result
  FROM ertad.organizations o WHERE o.status='active' AND EXISTS(SELECT 1 FROM ertad.units u WHERE u.organization_id=o.id
  AND (ertad.review_has_scope(actor,o.id,u.id,'decision.read') OR ertad.review_has_scope(actor,o.id,u.id,'decision.vote')));
 ELSIF op='audiences' THEN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',u.id,'name',u.name) ORDER BY u.name,u.id),'[]') INTO result
  FROM (SELECT * FROM ertad.units u WHERE u.organization_id=org AND u.kind='authority'
   AND ertad.review_has_scope(actor,org,u.id,'decision.manage') AND ertad.review_has_scope(actor,org,u.id,'decision.read') ORDER BY name,id LIMIT 250) u;
 ELSIF op='list' THEN
  n:=COALESCE((input->>'page')::integer,1); view_name:=COALESCE(input->>'view','open');
  IF n NOT BETWEEN 1 AND 1000 OR view_name NOT IN ('draft','open','closed','cancelled') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid filter'; END IF;
  WITH visible AS (SELECT d.* FROM ertad.decisions d WHERE d.organization_id=org AND ertad.decision_visible(actor,d)
   AND CASE WHEN d.status='open' AND d.closes_at<=clock_timestamp() THEN 'closed' ELSE d.status END=view_name
   AND position(lower(COALESCE(input->>'search','')) in lower(d.title))>0),
  paged AS (SELECT * FROM visible ORDER BY created_at DESC,id LIMIT 25 OFFSET (n-1)*25)
  SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(ertad.decision_view(actor,paged::ertad.decisions) ORDER BY created_at DESC,id) FROM paged),'[]'),
   'total',(SELECT count(*) FROM visible),'page',n,'pageSize',25) INTO result;
 ELSE
  IF op='create' THEN
   target:=(input->>'unitId')::uuid;
  ELSE
   SELECT * INTO d FROM ertad.decisions WHERE organization_id=org AND id=(input->>'id')::uuid;
   IF NOT FOUND OR NOT ertad.decision_visible(actor,d) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
   target:=d.unit_id;
  END IF;
  permission:=CASE WHEN op IN ('create','update','cancel') THEN 'decision.manage' WHEN op IN ('publish','close') THEN 'decision.publish' END;
  IF permission IS NOT NULL AND (NOT ertad.review_has_scope(actor,org,target,permission) OR NOT ertad.review_has_scope(actor,org,target,'decision.read')) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
  IF op='vote' AND NOT EXISTS(SELECT 1 FROM ertad.decision_electorate e WHERE e.organization_id=org AND e.decision_id=d.id AND e.user_id=actor
   AND ertad.decision_eligible(actor,org,d.unit_id,e.membership_id)) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Not eligible'; END IF;
  IF mutation THEN
   payload:=input-'key';
   SELECT * INTO receipt FROM ertad.decision_commands WHERE organization_id=org AND actor_id=actor AND key=(input->>'key')::uuid;
   IF FOUND THEN
    IF receipt.operation<>op OR receipt.payload<>payload THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Retry conflict'; END IF;
    RETURN jsonb_build_object('data',receipt.response,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'decisionId',receipt.decision_id,'changed',false));
   END IF;
  END IF;
  IF op='detail' THEN
   result:=ertad.decision_view(actor,d);
  ELSIF op IN ('create','update') THEN
   SELECT COALESCE(array_agg(trim(value) ORDER BY ordinality),'{}'::text[]) INTO opts FROM jsonb_array_elements_text(input->'options') WITH ORDINALITY;
   IF NOT ertad.decision_definition_valid(COALESCE(input->>'kind','poll'),opts,(input->>'threshold')::integer,input->'questions')
    OR (input->>'closesAt')::timestamptz<=clock_timestamp() OR (input->>'closesAt')::timestamptz>clock_timestamp()+interval '90 days' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid decision definition'; END IF;
   IF NOT EXISTS(SELECT 1 FROM ertad.units WHERE organization_id=org AND id=target AND kind='authority' AND status='active') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Invalid audience'; END IF;
   IF op='create' THEN
    INSERT INTO ertad.decisions(organization_id,unit_id,creator_id,title,description,options,quorum,closes_at,kind,threshold,questions)
     VALUES(org,target,actor,trim(input->>'title'),input->>'description',opts,(input->>'quorum')::integer,(input->>'closesAt')::timestamptz,COALESCE(input->>'kind','poll'),(input->>'threshold')::integer,input->'questions') RETURNING * INTO d;
   ELSE
    IF d.status<>'draft' OR d.version IS DISTINCT FROM (input->>'version')::integer OR d.unit_id IS DISTINCT FROM (input->>'unitId')::uuid THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Draft conflict'; END IF;
    UPDATE ertad.decisions SET title=trim(input->>'title'),description=input->>'description',options=opts,quorum=(input->>'quorum')::integer,
     closes_at=(input->>'closesAt')::timestamptz,kind=COALESCE(input->>'kind','poll'),threshold=(input->>'threshold')::integer,questions=input->'questions',version=version+1 WHERE organization_id=org AND id=d.id RETURNING * INTO d;
   END IF;
   changed:=true; result:=jsonb_build_object('id',d.id,'status',d.status);
  ELSIF op='publish' THEN
   IF d.status<>'draft' OR d.version IS DISTINCT FROM (input->>'version')::integer OR d.closes_at<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Publication conflict'; END IF;
   INSERT INTO ertad.decision_electorate(organization_id,decision_id,user_id,membership_id)
    SELECT DISTINCT ON (m.user_id) org,d.id,m.user_id,m.id FROM ertad.memberships m WHERE m.organization_id=org
     AND ertad.decision_eligible(m.user_id,org,d.unit_id,m.id) ORDER BY m.user_id,m.id;
   IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Empty electorate'; END IF;
   UPDATE ertad.decisions SET status='open',opened_at=clock_timestamp(),scope_path=ertad.unit_path(org,unit_id),version=version+1
    WHERE organization_id=org AND id=d.id RETURNING * INTO d;
   changed:=true; result:=jsonb_build_object('id',d.id,'status','open');
  ELSIF op IN ('close','cancel') THEN
   IF d.version IS DISTINCT FROM (input->>'version')::integer OR d.status NOT IN ('draft','open') OR (op='close' AND d.status<>'open')
    OR (op='cancel' AND d.status='open' AND d.closes_at<=clock_timestamp()) THEN
    RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='State conflict'; END IF;
   UPDATE ertad.decisions SET status=CASE WHEN op='close' THEN 'closed' ELSE 'cancelled' END,closed_at=clock_timestamp(),version=version+1
    WHERE organization_id=org AND id=d.id RETURNING * INTO d;
   changed:=true; result:=jsonb_build_object('id',d.id,'status',d.status);
  ELSIF op='vote' THEN
   IF d.status<>'open' OR d.closes_at<=clock_timestamp() OR d.scope_path IS DISTINCT FROM ertad.unit_path(org,d.unit_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Poll closed or scope changed'; END IF;
   IF d.kind='survey' THEN
    IF input ? 'choice' OR NOT ertad.decision_answers_valid(d.questions,input->'answers') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid survey answers'; END IF;
    IF EXISTS(SELECT 1 FROM ertad.decision_survey_responses WHERE organization_id=org AND decision_id=d.id AND user_id=actor) THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Already participated'; END IF;
    INSERT INTO ertad.decision_survey_responses VALUES(org,d.id,actor,input->'answers');
   ELSE
    chosen:=(input->>'choice')::integer;
    IF input ? 'answers' OR chosen IS NULL OR chosen<0 OR chosen>=cardinality(d.options) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid choice'; END IF;
    IF EXISTS(SELECT 1 FROM ertad.decision_named_votes WHERE organization_id=org AND decision_id=d.id AND user_id=actor) THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Already participated'; END IF;
    INSERT INTO ertad.decision_named_votes VALUES(org,d.id,actor,chosen);
   END IF;
   changed:=true; result:=jsonb_build_object('id',d.id,'status','recorded');
  END IF;
  IF mutation THEN INSERT INTO ertad.decision_commands VALUES(org,actor,(input->>'key')::uuid,d.id,op,payload,result); END IF;
 END IF;
 RETURN jsonb_build_object('data',result,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'decisionId',d.id,'changed',changed));
END; $$;


REVOKE ALL ON TABLE ertad.decision_survey_responses FROM PUBLIC,ertad_app;
REVOKE ALL ON FUNCTION ertad.decision_options_valid(text[]),ertad.decision_definition_valid(text,text[],integer,jsonb),ertad.decision_answers_valid(jsonb,jsonb),ertad.decision_survey_results(uuid,ertad.decisions) FROM PUBLIC;
