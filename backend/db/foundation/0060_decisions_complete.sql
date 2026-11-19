-- Complete Decisions V1 gates: multi-unit audiences/exclusions & estimates, scheduled opening,
-- unlinkable anonymous ballots with k>=10 floor & participation-only rewards, candidate nominations/withdrawals,
-- and non-executing binding-review governance mode.

ALTER TABLE ertad.decisions DROP CONSTRAINT decisions_privacy_check;
ALTER TABLE ertad.decisions ADD CONSTRAINT decisions_privacy_check CHECK(privacy IN ('named','anonymous'));
ALTER TABLE ertad.decisions ADD COLUMN included_unit_ids uuid[];
ALTER TABLE ertad.decisions ADD COLUMN excluded_unit_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
ALTER TABLE ertad.decisions ADD COLUMN opens_at timestamptz;
ALTER TABLE ertad.decisions ADD COLUMN governance_mode text NOT NULL DEFAULT 'advisory' CHECK(governance_mode IN ('advisory','binding_review'));
ALTER TABLE ertad.decisions ADD COLUMN referendum_labels jsonb;
ALTER TABLE ertad.decisions ADD CONSTRAINT decisions_opens_before_close CHECK(opens_at IS NULL OR (isfinite(opens_at) AND opens_at < closes_at));

CREATE TABLE ertad.decision_nominations (
  organization_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  decision_id uuid NOT NULL,
  candidate_label text NOT NULL CHECK(length(trim(candidate_label)) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'nominated' CHECK(status IN ('nominated','withdrawn')),
  reason text NOT NULL DEFAULT '' CHECK(length(reason) <= 1000),
  created_by uuid NOT NULL REFERENCES ertad.member_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  withdrawn_by uuid REFERENCES ertad.member_users(id),
  withdrawn_at timestamptz,
  PRIMARY KEY(organization_id, id),
  FOREIGN KEY(organization_id, decision_id) REFERENCES ertad.decisions(organization_id, id),
  CHECK((status='nominated' AND withdrawn_at IS NULL AND withdrawn_by IS NULL)
     OR (status='withdrawn' AND withdrawn_at IS NOT NULL AND withdrawn_by IS NOT NULL))
);
CREATE INDEX decision_nominations_lookup ON ertad.decision_nominations(organization_id, decision_id, created_at, id);
REVOKE ALL ON ertad.decision_nominations FROM PUBLIC, ertad_app;

-- Unlinkable anonymous voting:
-- 1) decision_anonymous_participation records ONLY participation per member (enforces 1-vote + rewards).
-- 2) decision_anonymous_ballots stores ONLY choices/answers with ZERO user_id, key, or timestamp.
CREATE TABLE ertad.decision_anonymous_participation (
  organization_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  user_id uuid NOT NULL,
  PRIMARY KEY(organization_id, decision_id, user_id),
  FOREIGN KEY(organization_id, decision_id, user_id) REFERENCES ertad.decision_electorate(organization_id, decision_id, user_id)
);
CREATE TABLE ertad.decision_anonymous_ballots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  choice integer CHECK(choice BETWEEN 0 AND 7),
  answers jsonb CHECK(answers IS NULL OR jsonb_typeof(answers) = 'object'),
  FOREIGN KEY(organization_id, decision_id) REFERENCES ertad.decisions(organization_id, id),
  CHECK((choice IS NULL) <> (answers IS NULL))
);
CREATE INDEX decision_anonymous_ballots_tally ON ertad.decision_anonymous_ballots(organization_id, decision_id);
CREATE TRIGGER immutable_anonymous_participation BEFORE UPDATE OR DELETE ON ertad.decision_anonymous_participation
  FOR EACH ROW EXECUTE FUNCTION ertad.prevent_audit_log_mutation();
CREATE TRIGGER no_truncate_anonymous_participation BEFORE TRUNCATE ON ertad.decision_anonymous_participation
  FOR EACH STATEMENT EXECUTE FUNCTION ertad.prevent_audit_log_mutation();
CREATE TRIGGER immutable_anonymous_ballots BEFORE UPDATE OR DELETE ON ertad.decision_anonymous_ballots
  FOR EACH ROW EXECUTE FUNCTION ertad.prevent_audit_log_mutation();
CREATE TRIGGER no_truncate_anonymous_ballots BEFORE TRUNCATE ON ertad.decision_anonymous_ballots
  FOR EACH STATEMENT EXECUTE FUNCTION ertad.prevent_audit_log_mutation();
REVOKE ALL ON ertad.decision_anonymous_participation, ertad.decision_anonymous_ballots FROM PUBLIC, ertad_app;

-- Award participation-only contribution points for anonymous voting when electorate >= 10 without storing ballot content.
CREATE FUNCTION ertad.contribution_from_anonymous_decision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE d ertad.decisions; electorate_size integer;
BEGIN
  SELECT * INTO d FROM ertad.decisions WHERE organization_id=NEW.organization_id AND id=NEW.decision_id;
  IF d.privacy<>'anonymous' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Named decision cannot record anonymous receipt'; END IF;
  SELECT count(*) INTO electorate_size FROM ertad.decision_electorate WHERE organization_id=d.organization_id AND decision_id=d.id;
  IF electorate_size < 10 THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Anonymous electorate below minimum privacy threshold'; END IF;
  PERFORM ertad.contribution_issue(d.organization_id,d.unit_id,NEW.user_id,d.contribution_rule_id,'decision_participation',d.id,NULL,NULL,'');
  RETURN NEW;
END $$;
CREATE TRIGGER anonymous_participation_contribution AFTER INSERT ON ertad.decision_anonymous_participation
  FOR EACH ROW EXECUTE FUNCTION ertad.contribution_from_anonymous_decision();
REVOKE ALL ON FUNCTION ertad.contribution_from_anonymous_decision() FROM PUBLIC;

CREATE FUNCTION ertad.decision_referendum_labels_valid(labels jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE k text;
BEGIN
  IF labels IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(labels) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF labels - ARRAY['yes','no','abstain'] <> '{}'::jsonb THEN RETURN false; END IF;
  FOR k IN SELECT jsonb_object_keys(labels) LOOP
    IF jsonb_typeof(labels->k) IS DISTINCT FROM 'string' OR length(trim(labels->>k)) NOT BETWEEN 1 AND 80 THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END $$;

CREATE FUNCTION ertad.decision_unit_in_audience(org uuid, member_unit uuid, included uuid[], excluded uuid[]) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT p.path IS NOT NULL
    AND (p.path && included)
    AND NOT (p.path && COALESCE(excluded,'{}'::uuid[]))
  FROM (SELECT ertad.unit_path(org, member_unit) AS path) p
$$;

CREATE FUNCTION ertad.decision_eligible_audience(actor uuid, org uuid, primary_unit uuid, included uuid[], excluded uuid[], mid uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT EXISTS(
    SELECT 1 FROM ertad.memberships m
    JOIN ertad.positions p ON (p.organization_id,p.id,p.unit_id)=(m.organization_id,m.position_id,m.unit_id)
    JOIN ertad.permission_bundles b ON (b.organization_id,b.id,b.version)=(p.organization_id,p.bundle_id,p.bundle_version)
    JOIN ertad.permission_grants g ON (g.organization_id,g.bundle_id,g.bundle_version)=(b.organization_id,b.id,b.version)
    WHERE m.organization_id=org AND m.id=mid AND m.user_id=actor AND m.status='active'
      AND m.valid_from<=clock_timestamp() AND m.valid_until>clock_timestamp() AND p.status='active'
      AND b.status='approved' AND m.bundle_version=p.bundle_version AND g.permission='decision.vote'
      AND ertad.decision_unit_in_audience(org, m.unit_id, COALESCE(included, ARRAY[primary_unit]), excluded)
      AND ertad.review_has_scope(actor, org, m.unit_id, 'decision.vote')
  )
$$;

CREATE OR REPLACE FUNCTION ertad.decision_visible(actor uuid, d ertad.decisions) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT ertad.review_has_scope(actor,d.organization_id,d.unit_id,'decision.read') OR (
    d.status<>'draft' AND EXISTS(
      SELECT 1 FROM ertad.decision_electorate e
      WHERE e.organization_id=d.organization_id AND e.decision_id=d.id AND e.user_id=actor
        AND ertad.decision_eligible_audience(actor,d.organization_id,d.unit_id,d.included_unit_ids,d.excluded_unit_ids,e.membership_id)
    )
  )
$$;

CREATE OR REPLACE FUNCTION ertad.decision_survey_results(actor uuid, d ertad.decisions) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE q jsonb; r jsonb; results jsonb:='[]'; counts jsonb; answered integer; is_anon boolean:=d.privacy='anonymous';
BEGIN
  FOR q IN SELECT value FROM jsonb_array_elements(d.questions) LOOP
    IF is_anon THEN
      SELECT count(*) INTO answered FROM ertad.decision_anonymous_ballots WHERE organization_id=d.organization_id AND decision_id=d.id AND answers IS NOT NULL AND answers ? (q->>'id');
    ELSE
      SELECT count(*) INTO answered FROM ertad.decision_survey_responses WHERE organization_id=d.organization_id AND decision_id=d.id AND answers ? (q->>'id');
    END IF;
    r:=jsonb_build_object('id',q->>'id','title',q->>'title','type',q->>'type','answered',answered);
    IF q->>'type'='text' THEN
      -- Free-text responses can uniquely identify authors; redact snippets in anonymous mode.
      IF NOT is_anon AND ertad.review_has_scope(actor,d.organization_id,d.unit_id,'decision.manage') THEN
        SELECT COALESCE(jsonb_agg(answer ORDER BY answer),'[]') INTO counts
        FROM (SELECT answers->>(q->>'id') AS answer FROM ertad.decision_survey_responses
              WHERE organization_id=d.organization_id AND decision_id=d.id AND answers ? (q->>'id')
              ORDER BY answers->>(q->>'id') LIMIT 25) texts;
        r:=r||jsonb_build_object('texts',counts,'truncated',answered>25);
      ELSIF is_anon THEN
        r:=r||jsonb_build_object('textsRedacted',true);
      END IF;
    ELSIF q->>'type'='rating_scale' THEN
      IF is_anon THEN
        SELECT jsonb_agg(jsonb_build_object('label',n::text,'votes',(SELECT count(*) FROM ertad.decision_anonymous_ballots WHERE organization_id=d.organization_id AND decision_id=d.id AND answers IS NOT NULL AND answers->(q->>'id')=to_jsonb(n))) ORDER BY n) INTO counts FROM generate_series((q->>'min')::integer,(q->>'max')::integer) n;
        r:=r||jsonb_build_object('results',counts,'average',(SELECT round(avg((answers->>(q->>'id'))::numeric),2) FROM ertad.decision_anonymous_ballots WHERE organization_id=d.organization_id AND decision_id=d.id AND answers IS NOT NULL AND answers ? (q->>'id')));
      ELSE
        SELECT jsonb_agg(jsonb_build_object('label',n::text,'votes',(SELECT count(*) FROM ertad.decision_survey_responses WHERE organization_id=d.organization_id AND decision_id=d.id AND answers->(q->>'id')=to_jsonb(n))) ORDER BY n) INTO counts FROM generate_series((q->>'min')::integer,(q->>'max')::integer) n;
        r:=r||jsonb_build_object('results',counts,'average',(SELECT round(avg((answers->>(q->>'id'))::numeric),2) FROM ertad.decision_survey_responses WHERE organization_id=d.organization_id AND decision_id=d.id AND answers ? (q->>'id')));
      END IF;
    ELSE
      IF is_anon THEN
        SELECT jsonb_agg(jsonb_build_object('label',o.label,'votes',COALESCE((SELECT sum(CASE
          WHEN q->>'type'='single_choice' THEN CASE WHEN s.answers->(q->>'id')=to_jsonb(o.n-1) THEN 1 ELSE 0 END
          WHEN q->>'type'='multiple_choice' THEN CASE WHEN s.answers->(q->>'id') @> to_jsonb(o.n-1) THEN 1 ELSE 0 END
          ELSE (SELECT jsonb_array_length(q->'options')+1-position FROM jsonb_array_elements(s.answers->(q->>'id')) WITH ORDINALITY a(value,position) WHERE a.value=to_jsonb(o.n-1)) END)
          FROM ertad.decision_anonymous_ballots s WHERE s.organization_id=d.organization_id AND s.decision_id=d.id AND s.answers IS NOT NULL AND s.answers ? (q->>'id')),0)) ORDER BY o.n)
        INTO counts FROM jsonb_array_elements_text(q->'options') WITH ORDINALITY o(label,n);
      ELSE
        SELECT jsonb_agg(jsonb_build_object('label',o.label,'votes',COALESCE((SELECT sum(CASE
          WHEN q->>'type'='single_choice' THEN CASE WHEN s.answers->(q->>'id')=to_jsonb(o.n-1) THEN 1 ELSE 0 END
          WHEN q->>'type'='multiple_choice' THEN CASE WHEN s.answers->(q->>'id') @> to_jsonb(o.n-1) THEN 1 ELSE 0 END
          ELSE (SELECT jsonb_array_length(q->'options')+1-position FROM jsonb_array_elements(s.answers->(q->>'id')) WITH ORDINALITY a(value,position) WHERE a.value=to_jsonb(o.n-1)) END)
          FROM ertad.decision_survey_responses s WHERE s.organization_id=d.organization_id AND s.decision_id=d.id AND s.answers ? (q->>'id')),0)) ORDER BY o.n)
        INTO counts FROM jsonb_array_elements_text(q->'options') WITH ORDINALITY o(label,n);
      END IF;
      r:=r||jsonb_build_object('results',counts);
    END IF;
    results:=results||jsonb_build_array(r);
  END LOOP;
  RETURN results;
END $$;

CREATE OR REPLACE FUNCTION ertad.decision_view(actor uuid, d ertad.decisions) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE finished boolean; scheduled boolean; eligible boolean; voted boolean; total integer; counts jsonb; result jsonb;
  participation integer; yes_count integer; no_count integer; outcome text; quorum_required integer;
BEGIN
  finished:=d.status='closed' OR (d.status='open' AND d.closes_at<=clock_timestamp());
  scheduled:=NOT finished AND d.status='open' AND d.opens_at IS NOT NULL AND d.opens_at>clock_timestamp();
  eligible:=EXISTS(SELECT 1 FROM ertad.decision_electorate e WHERE e.organization_id=d.organization_id AND e.decision_id=d.id AND e.user_id=actor
    AND ertad.decision_eligible_audience(actor,d.organization_id,d.unit_id,d.included_unit_ids,d.excluded_unit_ids,e.membership_id));
  IF d.privacy='anonymous' THEN
    voted:=EXISTS(SELECT 1 FROM ertad.decision_anonymous_participation WHERE organization_id=d.organization_id AND decision_id=d.id AND user_id=actor);
  ELSIF d.kind='survey' THEN
    voted:=EXISTS(SELECT 1 FROM ertad.decision_survey_responses WHERE organization_id=d.organization_id AND decision_id=d.id AND user_id=actor);
  ELSE
    voted:=EXISTS(SELECT 1 FROM ertad.decision_named_votes v WHERE v.organization_id=d.organization_id AND v.decision_id=d.id AND v.user_id=actor);
  END IF;
  SELECT count(*) INTO total FROM ertad.decision_electorate WHERE organization_id=d.organization_id AND decision_id=d.id;
  quorum_required:=CASE WHEN total=0 THEN 0 ELSE ceil(total * d.quorum / 100.0)::integer END;
  result:=jsonb_build_object(
    'id',d.id,'unitId',d.unit_id,'unitName',(SELECT name FROM ertad.units WHERE organization_id=d.organization_id AND id=d.unit_id),
    'includedUnitIds',COALESCE(d.included_unit_ids,ARRAY[d.unit_id]),
    'excludedUnitIds',d.excluded_unit_ids,
    'kind',d.kind,'threshold',d.threshold,'questions',d.questions,'title',d.title,'description',d.description,'options',d.options,
    'privacy',d.privacy,'governanceMode',d.governance_mode,'referendumLabels',d.referendum_labels,
    'version',d.version,'quorum',d.quorum,'quorumRequired',quorum_required,'opensAt',d.opens_at,'closesAt',d.closes_at,
    'status',CASE WHEN finished THEN 'closed' WHEN scheduled THEN 'scheduled' ELSE d.status END,
    'electorate',total,'voted',voted,
    'canManage',ertad.review_has_scope(actor,d.organization_id,d.unit_id,'decision.manage'),
    'canPublish',ertad.review_has_scope(actor,d.organization_id,d.unit_id,'decision.publish'),
    'canVote',eligible AND NOT voted AND d.status='open' AND NOT scheduled AND NOT finished AND d.scope_path=ertad.unit_path(d.organization_id,d.unit_id)
  );
  IF d.kind='election' THEN
    result:=result||jsonb_build_object('nominations',COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id',n.id,'label',n.candidate_label,'status',n.status,'reason',n.reason,'createdAt',n.created_at,'withdrawnAt',n.withdrawn_at) ORDER BY n.created_at, n.id)
      FROM ertad.decision_nominations n WHERE n.organization_id=d.organization_id AND n.decision_id=d.id
    ),'[]'::jsonb));
  END IF;
  result:=result||jsonb_build_object('contributionOffer',(
    SELECT jsonb_build_object('amount',r.amount,'memberMonthCap',r.member_month_cap,'ruleVersion',r.version)
    FROM ertad.contribution_rules r WHERE r.organization_id=d.organization_id AND r.id=d.contribution_rule_id AND r.enabled
  ));
  IF finished THEN
    IF d.privacy='anonymous' AND total < 10 THEN
      RETURN result||jsonb_build_object('resultsSuppressed',true);
    END IF;
    IF d.kind='survey' THEN
      IF d.privacy='anonymous' THEN
        SELECT count(*) INTO participation FROM ertad.decision_anonymous_participation WHERE organization_id=d.organization_id AND decision_id=d.id;
      ELSE
        SELECT count(*) INTO participation FROM ertad.decision_survey_responses WHERE organization_id=d.organization_id AND decision_id=d.id;
      END IF;
      RETURN result||jsonb_build_object('surveyResults',ertad.decision_survey_results(actor,d),'participation',participation,'quorumMet',participation*100>=total*d.quorum);
    END IF;
    IF d.privacy='anonymous' THEN
      SELECT jsonb_agg(jsonb_build_object('label',o.label,'votes',(SELECT count(*) FROM ertad.decision_anonymous_ballots b
        WHERE b.organization_id=d.organization_id AND b.decision_id=d.id AND b.choice=o.n-1)) ORDER BY o.n)
      INTO counts FROM unnest(d.options) WITH ORDINALITY o(label,n);
      SELECT count(*) INTO participation FROM ertad.decision_anonymous_participation WHERE organization_id=d.organization_id AND decision_id=d.id;
    ELSE
      SELECT jsonb_agg(jsonb_build_object('label',o.label,'votes',(SELECT count(*) FROM ertad.decision_named_votes v
        WHERE v.organization_id=d.organization_id AND v.decision_id=d.id AND v.choice=o.n-1)) ORDER BY o.n)
      INTO counts FROM unnest(d.options) WITH ORDINALITY o(label,n);
      SELECT count(*) INTO participation FROM ertad.decision_named_votes WHERE organization_id=d.organization_id AND decision_id=d.id;
    END IF;
    result:=result||jsonb_build_object('results',counts,'participation',participation,'quorumMet',participation*100>=total*d.quorum);
    IF d.kind='referendum' THEN
      yes_count:=(counts->0->>'votes')::integer; no_count:=(counts->1->>'votes')::integer;
      outcome:=CASE WHEN participation*100<total*d.quorum THEN 'inquorate'
        WHEN yes_count+no_count=0 THEN 'no_decision' WHEN yes_count=no_count THEN 'tie'
        WHEN yes_count>no_count AND yes_count*100 >= (yes_count+no_count)*d.threshold THEN 'accepted' ELSE 'rejected' END;
      result:=result||jsonb_build_object('outcome',outcome);
    END IF;
  END IF;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION ertad.decision_command(sid uuid, token text, op text, org uuid, input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_column
DECLARE actor uuid; d ertad.decisions; receipt ertad.decision_commands; result jsonb; changed boolean:=false;
  mutation boolean; permission text; opts text[]; target uuid; n integer; view_name text; payload jsonb; chosen integer;
  included_ids uuid[]; excluded_ids uuid[]; opens timestamptz; closes timestamptz; privacy_mode text; gov_mode text;
  ref_labels jsonb; candidate_txt text; nom_row ertad.decision_nominations; est_count integer; uid uuid;
BEGIN
  IF op NOT IN ('contexts','audiences','estimate','list','detail','create','update','publish','close','cancel','vote','nominate','withdraw_nomination') THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid operation';
  END IF;
  mutation:=op IN ('create','update','publish','close','cancel','vote','nominate','withdraw_nomination');
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
    FROM (SELECT * FROM ertad.units u WHERE u.organization_id=org AND u.kind='authority' AND u.status='active'
      AND ertad.review_has_scope(actor,org,u.id,'decision.manage') AND ertad.review_has_scope(actor,org,u.id,'decision.read') ORDER BY name,id LIMIT 250) u;
  ELSIF op='estimate' THEN
    SELECT COALESCE(array_agg(value::uuid),'{}'::uuid[]) INTO included_ids FROM jsonb_array_elements_text(input->'includedUnitIds');
    SELECT COALESCE(array_agg(value::uuid),'{}'::uuid[]) INTO excluded_ids FROM jsonb_array_elements_text(COALESCE(input->'excludedUnitIds','[]'::jsonb));
    IF cardinality(included_ids) NOT BETWEEN 1 AND 25 OR cardinality(excluded_ids) > 25 OR (included_ids && excluded_ids) THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid audience units';
    END IF;
    FOREACH uid IN ARRAY (included_ids || excluded_ids) LOOP
      IF NOT EXISTS(SELECT 1 FROM ertad.units WHERE organization_id=org AND id=uid AND kind='authority' AND status='active')
      OR NOT ertad.review_has_scope(actor,org,uid,'decision.manage') OR NOT ertad.review_has_scope(actor,org,uid,'decision.read') THEN
        RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied';
      END IF;
    END LOOP;
    SELECT count(DISTINCT m.user_id)::integer INTO est_count FROM ertad.memberships m
    WHERE m.organization_id=org AND ertad.decision_eligible_audience(m.user_id,org,included_ids[1],included_ids,excluded_ids,m.id);
    result:=jsonb_build_object('electorateCount',est_count,'meetsAnonymousFloor',est_count >= 10);
  ELSIF op='list' THEN
    n:=COALESCE((input->>'page')::integer,1); view_name:=COALESCE(input->>'view','open');
    IF n NOT BETWEEN 1 AND 1000 OR view_name NOT IN ('draft','scheduled','open','closed','cancelled') THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid filter';
    END IF;
    WITH visible AS (
      SELECT d.* FROM ertad.decisions d WHERE d.organization_id=org AND ertad.decision_visible(actor,d)
      AND CASE
        WHEN d.status='open' AND d.closes_at<=clock_timestamp() THEN 'closed'
        WHEN d.status='open' AND d.opens_at IS NOT NULL AND d.opens_at>clock_timestamp() THEN 'scheduled'
        ELSE d.status END = view_name
      AND position(lower(COALESCE(input->>'search','')) in lower(d.title))>0
    ),
    paged AS (SELECT * FROM visible ORDER BY created_at DESC,id LIMIT 25 OFFSET (n-1)*25)
    SELECT jsonb_build_object(
      'items',COALESCE((SELECT jsonb_agg(ertad.decision_view(actor,paged::ertad.decisions) ORDER BY created_at DESC,id) FROM paged),'[]'),
      'total',(SELECT count(*) FROM visible),'page',n,'pageSize',25
    ) INTO result;
  ELSE
    IF op='create' THEN
      target:=(input->>'unitId')::uuid;
    ELSE
      SELECT * INTO d FROM ertad.decisions WHERE organization_id=org AND id=(input->>'id')::uuid;
      IF NOT FOUND OR NOT ertad.decision_visible(actor,d) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
      target:=d.unit_id;
    END IF;
    permission:=CASE WHEN op IN ('create','update','cancel','nominate','withdraw_nomination') THEN 'decision.manage' WHEN op IN ('publish','close') THEN 'decision.publish' END;
    IF permission IS NOT NULL AND (NOT ertad.review_has_scope(actor,org,target,permission) OR NOT ertad.review_has_scope(actor,org,target,'decision.read')) THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied';
    END IF;
    IF op='vote' AND NOT EXISTS(SELECT 1 FROM ertad.decision_electorate e WHERE e.organization_id=org AND e.decision_id=d.id AND e.user_id=actor
      AND ertad.decision_eligible_audience(actor,org,d.unit_id,d.included_unit_ids,d.excluded_unit_ids,e.membership_id)) THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Not eligible';
    END IF;
    IF mutation THEN
      -- For anonymous ballots, never bind actor_id receipt to ballot content!
      payload:=CASE WHEN op='vote' AND d.privacy='anonymous' THEN '{"anonymous":true}'::jsonb ELSE input-'key' END;
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
      included_ids:=CASE WHEN input ? 'includedUnitIds' THEN (SELECT COALESCE(array_agg(value::uuid),'{}'::uuid[]) FROM jsonb_array_elements_text(input->'includedUnitIds')) ELSE ARRAY[target] END;
      excluded_ids:=CASE WHEN input ? 'excludedUnitIds' THEN (SELECT COALESCE(array_agg(value::uuid),'{}'::uuid[]) FROM jsonb_array_elements_text(input->'excludedUnitIds')) ELSE '{}'::uuid[] END;
      opens:=(input->>'opensAt')::timestamptz; closes:=(input->>'closesAt')::timestamptz;
      privacy_mode:=COALESCE(input->>'privacy','named'); gov_mode:=COALESCE(input->>'governanceMode','advisory');
      ref_labels:=input->'referendumLabels';
      IF privacy_mode NOT IN ('named','anonymous') OR gov_mode NOT IN ('advisory','binding_review')
      OR NOT ertad.decision_referendum_labels_valid(ref_labels)
      OR (ref_labels IS NOT NULL AND COALESCE(input->>'kind','poll')<>'referendum')
      OR NOT ertad.decision_definition_valid(COALESCE(input->>'kind','poll'),opts,(input->>'threshold')::integer,input->'questions')
      OR closes<=clock_timestamp() OR closes>clock_timestamp()+interval '90 days'
      OR (opens IS NOT NULL AND (NOT isfinite(opens) OR opens<=clock_timestamp() OR opens>=closes))
      OR cardinality(included_ids) NOT BETWEEN 1 AND 25 OR cardinality(excluded_ids)>25
      OR NOT (target=ANY(included_ids)) OR (included_ids && excluded_ids) THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid decision definition';
      END IF;
      FOREACH uid IN ARRAY (included_ids || excluded_ids) LOOP
        IF NOT EXISTS(SELECT 1 FROM ertad.units WHERE organization_id=org AND id=uid AND kind='authority' AND status='active')
        OR NOT ertad.review_has_scope(actor,org,uid,'decision.manage') OR NOT ertad.review_has_scope(actor,org,uid,'decision.read') THEN
          RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Invalid audience unit';
        END IF;
      END LOOP;
      IF op='create' THEN
        INSERT INTO ertad.decisions(organization_id,unit_id,creator_id,title,description,options,privacy,quorum,opens_at,closes_at,kind,threshold,questions,included_unit_ids,excluded_unit_ids,governance_mode,referendum_labels)
        VALUES(org,target,actor,trim(input->>'title'),input->>'description',opts,privacy_mode,(input->>'quorum')::integer,opens,closes,COALESCE(input->>'kind','poll'),(input->>'threshold')::integer,input->'questions',included_ids,excluded_ids,gov_mode,ref_labels)
        RETURNING * INTO d;
      ELSE
        IF d.status<>'draft' OR d.version IS DISTINCT FROM (input->>'version')::integer OR d.unit_id IS DISTINCT FROM (input->>'unitId')::uuid THEN
          RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Draft conflict';
        END IF;
        UPDATE ertad.decisions SET title=trim(input->>'title'),description=input->>'description',options=opts,privacy=privacy_mode,quorum=(input->>'quorum')::integer,
          opens_at=opens,closes_at=closes,kind=COALESCE(input->>'kind','poll'),threshold=(input->>'threshold')::integer,questions=input->'questions',
          included_unit_ids=included_ids,excluded_unit_ids=excluded_ids,governance_mode=gov_mode,referendum_labels=ref_labels,version=version+1
        WHERE organization_id=org AND id=d.id RETURNING * INTO d;
      END IF;
      changed:=true; result:=jsonb_build_object('id',d.id,'status',d.status);
    ELSIF op='nominate' THEN
      candidate_txt:=trim(COALESCE(input->>'candidateLabel',''));
      IF d.status<>'draft' OR d.kind<>'election' OR d.version IS DISTINCT FROM (input->>'version')::integer THEN
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Nomination unavailable';
      END IF;
      IF length(candidate_txt) NOT BETWEEN 1 AND 160 OR cardinality(d.options)>=8
      OR EXISTS(SELECT 1 FROM unnest(d.options) o WHERE lower(trim(o))=lower(candidate_txt)) THEN
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Candidate conflict or limit';
      END IF;
      INSERT INTO ertad.decision_nominations(organization_id,decision_id,candidate_label,created_by)
      VALUES(org,d.id,candidate_txt,actor);
      UPDATE ertad.decisions SET options=array_append(options,candidate_txt),version=version+1 WHERE organization_id=org AND id=d.id RETURNING * INTO d;
      changed:=true; result:=jsonb_build_object('id',d.id,'status',d.status);
    ELSIF op='withdraw_nomination' THEN
      candidate_txt:=trim(COALESCE(input->>'candidateLabel',''));
      IF d.status<>'draft' OR d.kind<>'election' OR d.version IS DISTINCT FROM (input->>'version')::integer THEN
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Withdrawal unavailable';
      END IF;
      IF length(trim(COALESCE(input->>'reason',''))) < 3 OR cardinality(d.options) <= 2
      OR NOT EXISTS(SELECT 1 FROM unnest(d.options) o WHERE lower(trim(o))=lower(candidate_txt)) THEN
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Cannot withdraw below minimum candidates';
      END IF;
      SELECT * INTO nom_row FROM ertad.decision_nominations WHERE organization_id=org AND decision_id=d.id AND lower(trim(candidate_label))=lower(candidate_txt) AND status='nominated' LIMIT 1;
      IF FOUND THEN
        UPDATE ertad.decision_nominations SET status='withdrawn',reason=trim(input->>'reason'),withdrawn_by=actor,withdrawn_at=clock_timestamp()
        WHERE organization_id=org AND id=nom_row.id;
      ELSE
        INSERT INTO ertad.decision_nominations(organization_id,decision_id,candidate_label,status,reason,created_by,withdrawn_by,withdrawn_at)
        VALUES(org,d.id,candidate_txt,'withdrawn',trim(input->>'reason'),actor,actor,clock_timestamp());
      END IF;
      UPDATE ertad.decisions SET options=COALESCE((SELECT array_agg(o ORDER BY ord) FROM unnest(d.options) WITH ORDINALITY t(o,ord) WHERE lower(trim(o))<>lower(candidate_txt)),'{}'::text[]),version=version+1
      WHERE organization_id=org AND id=d.id RETURNING * INTO d;
      changed:=true; result:=jsonb_build_object('id',d.id,'status',d.status);
    ELSIF op='publish' THEN
      IF d.status<>'draft' OR d.version IS DISTINCT FROM (input->>'version')::integer OR d.closes_at<=clock_timestamp()
      OR (d.opens_at IS NOT NULL AND d.opens_at>=d.closes_at) THEN
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Publication conflict';
      END IF;
      FOREACH uid IN ARRAY (COALESCE(d.included_unit_ids,ARRAY[d.unit_id]) || d.excluded_unit_ids) LOOP
        IF NOT EXISTS(SELECT 1 FROM ertad.units WHERE organization_id=org AND id=uid AND kind='authority' AND status='active')
        OR NOT ertad.review_has_scope(actor,org,uid,'decision.publish') OR NOT ertad.review_has_scope(actor,org,uid,'decision.read') THEN
          RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Audience unit authority unavailable';
        END IF;
      END LOOP;
      INSERT INTO ertad.decision_electorate(organization_id,decision_id,user_id,membership_id)
      SELECT DISTINCT ON (m.user_id) org,d.id,m.user_id,m.id FROM ertad.memberships m
      WHERE m.organization_id=org AND ertad.decision_eligible_audience(m.user_id,org,d.unit_id,d.included_unit_ids,d.excluded_unit_ids,m.id)
      ORDER BY m.user_id,m.id;
      SELECT count(*) INTO n FROM ertad.decision_electorate WHERE organization_id=org AND decision_id=d.id;
      IF n = 0 THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Empty electorate'; END IF;
      IF d.privacy='anonymous' AND n < 10 THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Anonymous audience below minimum privacy threshold'; END IF;
      UPDATE ertad.decisions SET status='open',opened_at=clock_timestamp(),scope_path=ertad.unit_path(org,unit_id),version=version+1
      WHERE organization_id=org AND id=d.id RETURNING * INTO d;
      changed:=true; result:=jsonb_build_object('id',d.id,'status',CASE WHEN d.opens_at IS NOT NULL AND d.opens_at>clock_timestamp() THEN 'scheduled' ELSE 'open' END);
    ELSIF op IN ('close','cancel') THEN
      IF d.version IS DISTINCT FROM (input->>'version')::integer OR d.status NOT IN ('draft','open') OR (op='close' AND d.status<>'open')
      OR (op='cancel' AND d.status='open' AND d.closes_at<=clock_timestamp()) THEN
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='State conflict';
      END IF;
      UPDATE ertad.decisions SET status=CASE WHEN op='close' THEN 'closed' ELSE 'cancelled' END,closed_at=clock_timestamp(),version=version+1
      WHERE organization_id=org AND id=d.id RETURNING * INTO d;
      changed:=true; result:=jsonb_build_object('id',d.id,'status',d.status);
    ELSIF op='vote' THEN
      IF d.status<>'open' OR (d.opens_at IS NOT NULL AND d.opens_at>clock_timestamp()) OR d.closes_at<=clock_timestamp()
      OR d.scope_path IS DISTINCT FROM ertad.unit_path(org,d.unit_id) THEN
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Poll closed, scheduled or scope changed';
      END IF;
      IF d.kind='survey' THEN
        IF input ? 'choice' OR NOT ertad.decision_answers_valid(d.questions,input->'answers') THEN
          RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid survey answers';
        END IF;
      ELSE
        chosen:=(input->>'choice')::integer;
        IF input ? 'answers' OR chosen IS NULL OR chosen<0 OR chosen>=cardinality(d.options) THEN
          RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid choice';
        END IF;
      END IF;
      IF d.privacy='anonymous' THEN
        IF EXISTS(SELECT 1 FROM ertad.decision_anonymous_participation WHERE organization_id=org AND decision_id=d.id AND user_id=actor) THEN
          RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Already participated';
        END IF;
        INSERT INTO ertad.decision_anonymous_participation VALUES(org,d.id,actor);
        INSERT INTO ertad.decision_anonymous_ballots(organization_id,decision_id,choice,answers)
        VALUES(org,d.id,CASE WHEN d.kind='survey' THEN NULL ELSE chosen END,CASE WHEN d.kind='survey' THEN input->'answers' ELSE NULL END);
      ELSIF d.kind='survey' THEN
        IF EXISTS(SELECT 1 FROM ertad.decision_survey_responses WHERE organization_id=org AND decision_id=d.id AND user_id=actor) THEN
          RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Already participated';
        END IF;
        INSERT INTO ertad.decision_survey_responses VALUES(org,d.id,actor,input->'answers');
      ELSE
        IF EXISTS(SELECT 1 FROM ertad.decision_named_votes WHERE organization_id=org AND decision_id=d.id AND user_id=actor) THEN
          RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Already participated';
        END IF;
        INSERT INTO ertad.decision_named_votes VALUES(org,d.id,actor,chosen);
      END IF;
      changed:=true; result:=jsonb_build_object('id',d.id,'status','recorded');
    END IF;
    IF mutation THEN
      -- For anonymous voting, never record choice/answers inside decision_commands or audit!
      INSERT INTO ertad.decision_commands VALUES(org,actor,(input->>'key')::uuid,d.id,op,payload,result);
    END IF;
  END IF;
  RETURN jsonb_build_object('data',result,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'decisionId',d.id,'changed',changed));
END $$;

CREATE OR REPLACE FUNCTION ertad.decision_finish(sid uuid, token text, org uuid, did uuid, op text, changed boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid; d ertad.decisions; permission text; uid uuid;
BEGIN
  actor:=ertad.review_identity(sid,token,true);
  SELECT * INTO d FROM ertad.decisions WHERE organization_id=org AND id=did;
  IF NOT FOUND OR NOT ertad.decision_visible(actor,d) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
  permission:=CASE WHEN op IN ('create','update','cancel','nominate','withdraw_nomination') THEN 'decision.manage' WHEN op IN ('publish','close') THEN 'decision.publish' END;
  IF permission IS NOT NULL THEN
    IF NOT ertad.review_has_scope(actor,org,d.unit_id,permission) OR NOT ertad.review_has_scope(actor,org,d.unit_id,'decision.read') THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied';
    END IF;
    IF op IN ('create','update','publish') THEN
      FOREACH uid IN ARRAY (COALESCE(d.included_unit_ids,ARRAY[d.unit_id]) || d.excluded_unit_ids) LOOP
        IF NOT ertad.review_has_scope(actor,org,uid,permission) OR NOT ertad.review_has_scope(actor,org,uid,'decision.read') THEN
          RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Audience unit authority expired';
        END IF;
      END LOOP;
    END IF;
  END IF;
  IF op='vote' AND NOT EXISTS(SELECT 1 FROM ertad.decision_electorate e WHERE e.organization_id=org AND e.decision_id=did AND e.user_id=actor
    AND ertad.decision_eligible_audience(actor,org,d.unit_id,d.included_unit_ids,d.excluded_unit_ids,e.membership_id)) THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Not eligible';
  END IF;
  IF changed AND op='publish' AND (d.closes_at<=clock_timestamp() OR d.scope_path IS DISTINCT FROM ertad.unit_path(org,d.unit_id)
    OR (d.privacy='anonymous' AND (SELECT count(*) FROM ertad.decision_electorate WHERE organization_id=org AND decision_id=did) < 10)) THEN
    RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Deadline, privacy floor or scope changed';
  END IF;
  IF changed AND op='vote' AND ((d.opens_at IS NOT NULL AND d.opens_at>clock_timestamp()) OR d.closes_at<=clock_timestamp()
    OR d.scope_path IS DISTINCT FROM ertad.unit_path(org,d.unit_id)) THEN
    RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Window or scope changed';
  END IF;
  IF changed AND op='cancel' AND d.opened_at IS NOT NULL AND d.closes_at<=clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Poll already closed';
  END IF;
END $$;

-- Include anonymous Decisions in Inbox without clobbering moderation/contribution wrappers (0020/0021).
CREATE OR REPLACE FUNCTION ertad.inbox_prior_moderation_entries(actor uuid, org uuid) RETURNS TABLE(
  source text, id uuid, version integer, unit_id uuid, title text, status text, updated_at timestamptz, deadline timestamptz, unread boolean, action text
) LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT * FROM ertad.inbox_workflow_entries(actor,org)
  UNION ALL
  SELECT 'decision',d.id,n.version,d.unit_id,d.title,
    CASE WHEN d.status='open' AND d.closes_at<=clock_timestamp() THEN 'closed'
         WHEN d.status='open' AND d.opens_at IS NOT NULL AND d.opens_at>clock_timestamp() THEN 'scheduled'
         ELSE d.status END,
    CASE WHEN d.status IN ('closed','cancelled') THEN d.closed_at
         WHEN d.closes_at<=clock_timestamp() THEN d.closes_at ELSE COALESCE(d.opens_at, d.opened_at) END,
    d.closes_at,
    COALESCE(r.read_version,0)<n.version,
    CASE WHEN d.status='open' AND d.closes_at>clock_timestamp() AND (d.opens_at IS NULL OR d.opens_at<=clock_timestamp()) AND e.eligible AND (
      CASE WHEN d.privacy='anonymous' THEN NOT EXISTS(SELECT 1 FROM ertad.decision_anonymous_participation v WHERE v.organization_id=org AND v.decision_id=d.id AND v.user_id=actor)
           WHEN d.kind='survey' THEN NOT EXISTS(SELECT 1 FROM ertad.decision_survey_responses v WHERE v.organization_id=org AND v.decision_id=d.id AND v.user_id=actor)
           ELSE NOT EXISTS(SELECT 1 FROM ertad.decision_named_votes v WHERE v.organization_id=org AND v.decision_id=d.id AND v.user_id=actor) END
    ) THEN 'decision_participate' ELSE '' END
  FROM ertad.decisions d
  CROSS JOIN LATERAL(SELECT EXISTS(
    SELECT 1 FROM ertad.decision_electorate e
    WHERE e.organization_id=org AND e.decision_id=d.id AND e.user_id=actor
      AND ertad.decision_eligible_audience(actor,org,d.unit_id,d.included_unit_ids,d.excluded_unit_ids,e.membership_id)
  ) eligible) e
  CROSS JOIN LATERAL(SELECT CASE WHEN d.status='cancelled' THEN 4 WHEN d.status='closed' THEN 3
    WHEN d.closes_at<=clock_timestamp() THEN 2 ELSE 1 END version) n
  LEFT JOIN ertad.decision_inbox_reads r ON r.organization_id=org AND r.decision_id=d.id AND r.recipient_id=actor
  WHERE d.organization_id=org AND d.privacy IN ('named','anonymous') AND d.opened_at IS NOT NULL AND d.status<>'draft'
    AND d.scope_path=ertad.unit_path(org,d.unit_id) AND ertad.decision_visible(actor,d)
    AND (e.eligible OR d.creator_id=actor OR ertad.review_has_scope(actor,org,d.unit_id,'decision.manage')
      OR ertad.review_has_scope(actor,org,d.unit_id,'decision.publish'))
$$;

REVOKE ALL ON FUNCTION ertad.decision_referendum_labels_valid(jsonb), ertad.decision_unit_in_audience(uuid,uuid,uuid[],uuid[]),
  ertad.decision_eligible_audience(uuid,uuid,uuid,uuid[],uuid[],uuid), ertad.inbox_prior_moderation_entries(uuid,uuid) FROM PUBLIC, ertad_app;
REVOKE ALL ON FUNCTION ertad.decision_command(uuid,text,text,uuid,jsonb), ertad.decision_finish(uuid,text,uuid,uuid,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.decision_command(uuid,text,text,uuid,jsonb), ertad.decision_finish(uuid,text,uuid,uuid,text,boolean) TO ertad_app;
