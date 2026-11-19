-- Make the anonymous-decision electorate threshold (k) admin-configurable via dual-control
-- security limits and optional per-poll tightening, eliminating hardcoded privacy constants.

ALTER TABLE ertad.security_limits_proposals
  ADD COLUMN anonymous_min_electorate integer NOT NULL DEFAULT 10
  CHECK (anonymous_min_electorate BETWEEN 2 AND 1000);

ALTER TABLE ertad.decisions
  ADD COLUMN anonymous_min_electorate integer
  CHECK (anonymous_min_electorate IS NULL OR anonymous_min_electorate BETWEEN 2 AND 1000);

CREATE OR REPLACE FUNCTION ertad.current_security_limits() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT COALESCE(
    (
      SELECT jsonb_build_object(
        'version', version,
        'apiPerMinute', api_per_minute,
        'loginFailures', login_failures,
        'lockoutMinutes', lockout_minutes,
        'anonymousMinElectorate', anonymous_min_electorate
      )
      FROM ertad.security_limits_proposals
      WHERE status = 'approved'
      ORDER BY version DESC
      LIMIT 1
    ),
    '{"version":0,"apiPerMinute":120,"loginFailures":5,"lockoutMinutes":15,"anonymousMinElectorate":10}'::jsonb
  )
$$;

CREATE FUNCTION ertad.anonymous_min_electorate() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT COALESCE((ertad.current_security_limits()->>'anonymousMinElectorate')::integer, 10)
$$;

REVOKE ALL ON FUNCTION ertad.current_security_limits(), ertad.anonymous_min_electorate() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.current_security_limits(), ertad.anonymous_min_electorate() TO ertad_app;

CREATE OR REPLACE FUNCTION ertad.security_limits_command(sid uuid, token text, op text, input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE account uuid; capabilities text[]; session_row ertad.admin_sessions;
  proposal ertad.security_limits_proposals; current_version integer; data jsonb; audit jsonb;
  request_key uuid := (input->>'requestId')::uuid; proposal_id uuid := (input->>'proposalId')::uuid;
  action text := input->>'action'; cursor_id uuid := (input->>'before')::uuid;
  anon_min integer;
BEGIN
  IF op IS NULL OR op NOT IN ('securityLimits','proposeSecurityLimits','reviewSecurityLimits') THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid policy command'; END IF;
  PERFORM ertad.platform_console_command(sid,token,'overview','{}');
  SELECT * INTO session_row FROM ertad.admin_sessions WHERE id=sid;
  account := session_row.admin_user_id;
  SELECT permissions INTO capabilities FROM ertad.platform_accounts WHERE admin_user_id=account;
  IF NOT ('platform.limits.read'=ANY(capabilities)) THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
  current_version := COALESCE((ertad.current_security_limits()->>'version')::integer,0);
  audit := jsonb_build_object('adminUserId',account,'operation',op);

  IF op='securityLimits' THEN
    WITH selected AS (
      SELECT * FROM ertad.security_limits_proposals
      WHERE cursor_id IS NULL
        OR (created_at,id) < (SELECT created_at,id FROM ertad.security_limits_proposals WHERE id=cursor_id)
      ORDER BY created_at DESC,id DESC LIMIT 26
    ),
    paged AS (SELECT * FROM selected ORDER BY created_at DESC,id DESC LIMIT 25)
    SELECT jsonb_build_object(
      'current', ertad.current_security_limits(),
      'items', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id',id,'mine',proposer_id=account,'expectedVersion',expected_version,'version',version,
          'apiPerMinute',api_per_minute,'loginFailures',login_failures,'lockoutMinutes',lockout_minutes,
          'anonymousMinElectorate',anonymous_min_electorate,
          'reason',reason,'createdAt',created_at,'expiresAt',expires_at,'reviewedAt',reviewed_at,
          'status',CASE WHEN status='pending' AND expires_at<=clock_timestamp() THEN 'expired' ELSE status END
        ) ORDER BY created_at DESC,id DESC) FROM paged
      ),'[]'),
      'nextBefore', CASE WHEN (SELECT count(*) FROM selected)>25 THEN (SELECT id FROM paged ORDER BY created_at,id LIMIT 1) ELSE NULL END
    ) INTO data;
    RETURN jsonb_build_object('data',data,'audit',audit);
  END IF;

  IF session_row.step_up_expires_at IS NULL OR session_row.step_up_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE='P0428',MESSAGE='Fresh authentication required'; END IF;
  IF request_key IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Request key required'; END IF;

  IF op='proposeSecurityLimits' THEN
    IF NOT ('platform.limits.propose'=ANY(capabilities)) THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
    anon_min := COALESCE((input->>'anonymousMinElectorate')::integer, ertad.anonymous_min_electorate());
    IF input->>'expectedVersion' IS NULL OR input->>'apiPerMinute' IS NULL OR input->>'loginFailures' IS NULL OR input->>'lockoutMinutes' IS NULL
      OR input->>'reason' IS NULL OR (input->>'apiPerMinute')::integer NOT BETWEEN 60 AND 600
      OR (input->>'loginFailures')::integer NOT BETWEEN 3 AND 10 OR (input->>'lockoutMinutes')::integer NOT BETWEEN 5 AND 60
      OR anon_min NOT BETWEEN 2 AND 1000
      OR input->>'reason' NOT IN ('security_tightening','traffic_adjustment','recovery') THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid policy values'; END IF;
    SELECT * INTO proposal FROM ertad.security_limits_proposals WHERE proposer_id=account AND request_id=request_key;
    IF FOUND THEN
      IF proposal.expected_version<>(input->>'expectedVersion')::integer
        OR proposal.api_per_minute<>(input->>'apiPerMinute')::integer
        OR proposal.login_failures<>(input->>'loginFailures')::integer
        OR proposal.lockout_minutes<>(input->>'lockoutMinutes')::integer
        OR proposal.anonymous_min_electorate<>anon_min
        OR proposal.reason<>input->>'reason' THEN
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request key conflict';
      END IF;
      RETURN jsonb_build_object('data',jsonb_build_object('id',proposal.id),'audit',NULL);
    END IF;
    IF current_version<>(input->>'expectedVersion')::integer THEN
      RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Policy changed'; END IF;
    INSERT INTO ertad.security_limits_proposals(
      proposer_id,request_id,expected_version,api_per_minute,login_failures,lockout_minutes,anonymous_min_electorate,reason
    )
    VALUES(
      account,request_key,current_version,(input->>'apiPerMinute')::integer,(input->>'loginFailures')::integer,
      (input->>'lockoutMinutes')::integer,anon_min,input->>'reason'
    ) RETURNING * INTO proposal;
  ELSE
    IF proposal_id IS NULL OR action IS NULL OR action NOT IN ('approve','reject','withdraw') THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid review'; END IF;
    IF NOT (CASE WHEN action='withdraw' THEN 'platform.limits.propose' ELSE 'platform.limits.approve' END=ANY(capabilities)) THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
    SELECT * INTO proposal FROM ertad.security_limits_proposals WHERE id=proposal_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0404',MESSAGE='Proposal unavailable'; END IF;
    IF (action='withdraw' AND proposal.proposer_id<>account) OR (action<>'withdraw' AND proposal.proposer_id=account) THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Independent review required'; END IF;
    IF action='approve' THEN
      PERFORM 1 FROM ertad.platform_accounts WHERE admin_user_id=proposal.proposer_id FOR SHARE;
      PERFORM 1 FROM ertad.admin_users WHERE id=proposal.proposer_id FOR SHARE;
      IF proposal.expires_at<=clock_timestamp() THEN
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Review deadline expired'; END IF;
    END IF;
    IF action='approve' AND NOT EXISTS(
      SELECT 1 FROM ertad.platform_accounts p JOIN ertad.admin_users a ON a.id=p.admin_user_id
      WHERE p.admin_user_id=proposal.proposer_id AND p.revoked_at IS NULL AND p.valid_from<=clock_timestamp() AND p.valid_until>clock_timestamp()
        AND ARRAY['platform.read','platform.limits.read','platform.limits.propose'] <@ p.permissions
        AND a.is_active AND (a.locked_until IS NULL OR a.locked_until<=clock_timestamp())
    ) THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Proposer authority unavailable'; END IF;
    IF proposal.review_request_id=request_key AND proposal.reviewer_id=account THEN
      IF proposal.status<>(CASE action WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE 'withdrawn' END) THEN
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request key conflict'; END IF;
      RETURN jsonb_build_object('data',jsonb_build_object('id',proposal.id),'audit',NULL);
    END IF;
    IF proposal.status<>'pending' OR (action<>'withdraw' AND proposal.expires_at<=clock_timestamp())
      OR (action='approve' AND proposal.expected_version<>current_version) THEN
      RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Proposal changed or expired'; END IF;
    UPDATE ertad.security_limits_proposals
    SET status=CASE action WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE 'withdrawn' END,
        reviewer_id=account,review_request_id=request_key,reviewed_at=clock_timestamp(),
        version=CASE WHEN action='approve' THEN current_version+1 ELSE NULL END
    WHERE id=proposal.id RETURNING * INTO proposal;
  END IF;
  RETURN jsonb_build_object('data',jsonb_build_object('id',proposal.id),
    'audit',audit||jsonb_build_object('proposalId',proposal.id,'status',proposal.status,'version',proposal.version));
END $$;

REVOKE ALL ON FUNCTION ertad.security_limits_command(uuid,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.security_limits_command(uuid,text,text,jsonb) TO ertad_app;

-- Enforce the pinned per-decision or active platform anonymity floor without hardcoded constants.
CREATE OR REPLACE FUNCTION ertad.contribution_from_anonymous_decision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE d ertad.decisions; electorate_size integer; floor_min integer;
BEGIN
  SELECT * INTO d FROM ertad.decisions WHERE organization_id=NEW.organization_id AND id=NEW.decision_id;
  IF d.privacy<>'anonymous' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Named decision cannot record anonymous receipt'; END IF;
  floor_min := COALESCE(d.anonymous_min_electorate, ertad.anonymous_min_electorate());
  SELECT count(*) INTO electorate_size FROM ertad.decision_electorate WHERE organization_id=d.organization_id AND decision_id=d.id;
  IF electorate_size < floor_min THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Anonymous electorate below minimum privacy threshold'; END IF;
  PERFORM ertad.contribution_issue(d.organization_id,d.unit_id,NEW.user_id,d.contribution_rule_id,'decision_participation',d.id,NULL,NULL,'');
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION ertad.decision_view(actor uuid, d ertad.decisions) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE finished boolean; scheduled boolean; eligible boolean; voted boolean; total integer; counts jsonb; result jsonb;
  participation integer; yes_count integer; no_count integer; outcome text; quorum_required integer; floor_min integer;
BEGIN
  finished := d.status='closed' OR (d.status='open' AND d.closes_at<=clock_timestamp());
  scheduled := NOT finished AND d.status='open' AND d.opens_at IS NOT NULL AND d.opens_at>clock_timestamp();
  floor_min := COALESCE(d.anonymous_min_electorate, ertad.anonymous_min_electorate());
  eligible := EXISTS(SELECT 1 FROM ertad.decision_electorate e WHERE e.organization_id=d.organization_id AND e.decision_id=d.id AND e.user_id=actor
    AND ertad.decision_eligible_audience(actor,d.organization_id,d.unit_id,d.included_unit_ids,d.excluded_unit_ids,e.membership_id));
  IF d.privacy='anonymous' THEN
    voted := EXISTS(SELECT 1 FROM ertad.decision_anonymous_participation WHERE organization_id=d.organization_id AND decision_id=d.id AND user_id=actor);
  ELSIF d.kind='survey' THEN
    voted := EXISTS(SELECT 1 FROM ertad.decision_survey_responses WHERE organization_id=d.organization_id AND decision_id=d.id AND user_id=actor);
  ELSE
    voted := EXISTS(SELECT 1 FROM ertad.decision_named_votes v WHERE v.organization_id=d.organization_id AND v.decision_id=d.id AND v.user_id=actor);
  END IF;
  SELECT count(*) INTO total FROM ertad.decision_electorate WHERE organization_id=d.organization_id AND decision_id=d.id;
  quorum_required := CASE WHEN total=0 THEN 0 ELSE ceil(total * d.quorum / 100.0)::integer END;
  result := jsonb_build_object(
    'id',d.id,'unitId',d.unit_id,'unitName',(SELECT name FROM ertad.units WHERE organization_id=d.organization_id AND id=d.unit_id),
    'includedUnitIds',COALESCE(d.included_unit_ids,ARRAY[d.unit_id]),
    'excludedUnitIds',d.excluded_unit_ids,
    'kind',d.kind,'threshold',d.threshold,'questions',d.questions,'title',d.title,'description',d.description,'options',d.options,
    'privacy',d.privacy,'anonymousMinElectorate',floor_min,'governanceMode',d.governance_mode,'referendumLabels',d.referendum_labels,
    'version',d.version,'quorum',d.quorum,'quorumRequired',quorum_required,'opensAt',d.opens_at,'closesAt',d.closes_at,
    'status',CASE WHEN finished THEN 'closed' WHEN scheduled THEN 'scheduled' ELSE d.status END,
    'electorate',total,'voted',voted,
    'canManage',ertad.review_has_scope(actor,d.organization_id,d.unit_id,'decision.manage'),
    'canPublish',ertad.review_has_scope(actor,d.organization_id,d.unit_id,'decision.publish'),
    'canVote',eligible AND NOT voted AND d.status='open' AND NOT scheduled AND NOT finished AND d.scope_path=ertad.unit_path(d.organization_id,d.unit_id)
  );
  IF d.kind='election' THEN
    result := result||jsonb_build_object('nominations',COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id',n.id,'label',n.candidate_label,'status',n.status,'reason',n.reason,'createdAt',n.created_at,'withdrawnAt',n.withdrawn_at) ORDER BY n.created_at, n.id)
      FROM ertad.decision_nominations n WHERE n.organization_id=d.organization_id AND n.decision_id=d.id
    ),'[]'::jsonb));
  END IF;
  result := result||jsonb_build_object('contributionOffer',(
    SELECT jsonb_build_object('amount',r.amount,'memberMonthCap',r.member_month_cap,'ruleVersion',r.version)
    FROM ertad.contribution_rules r WHERE r.organization_id=d.organization_id AND r.id=d.contribution_rule_id AND r.enabled
  ));
  IF finished THEN
    IF d.privacy='anonymous' AND total < floor_min THEN
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
    result := result||jsonb_build_object('results',counts,'participation',participation,'quorumMet',participation*100>=total*d.quorum);
    IF d.kind='referendum' THEN
      yes_count := (counts->0->>'votes')::integer; no_count := (counts->1->>'votes')::integer;
      outcome := CASE WHEN participation*100<total*d.quorum THEN 'inquorate'
        WHEN yes_count+no_count=0 THEN 'no_decision' WHEN yes_count=no_count THEN 'tie'
        WHEN yes_count>no_count AND yes_count*100 >= (yes_count+no_count)*d.threshold THEN 'accepted' ELSE 'rejected' END;
      result := result||jsonb_build_object('outcome',outcome);
    END IF;
  END IF;
  RETURN result;
END $$;

-- Update the core decision command handler & post-audit check so anonymous_min_electorate
-- is never hardcoded and never hits immutable decision_commands triggers.
CREATE OR REPLACE FUNCTION ertad.decision_before_reporting_command(sid uuid, token text, op text, org uuid, input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_column
DECLARE actor uuid; d ertad.decisions; receipt ertad.decision_commands; result jsonb; changed boolean:=false;
  mutation boolean; permission text; opts text[]; target uuid; n integer; view_name text; payload jsonb; chosen integer;
  included_ids uuid[]; excluded_ids uuid[]; opens timestamptz; closes timestamptz; privacy_mode text; gov_mode text;
  ref_labels jsonb; candidate_txt text; nom_row ertad.decision_nominations; est_count integer; uid uuid;
  policy_floor integer; req_floor integer; eff_floor integer;
BEGIN
  IF op NOT IN ('contexts','audiences','estimate','list','detail','create','update','publish','close','cancel','vote','nominate','withdraw_nomination') THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid operation';
  END IF;
  policy_floor := ertad.anonymous_min_electorate();
  mutation := op IN ('create','update','publish','close','cancel','vote','nominate','withdraw_nomination');
  actor := ertad.review_identity(sid,token,mutation);
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
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id',o.id,'name',o.name,'anonymousMinElectorate',policy_floor
    ) ORDER BY o.name,o.id),'[]') INTO result
    FROM ertad.organizations o WHERE o.status='active' AND EXISTS(SELECT 1 FROM ertad.units u WHERE u.organization_id=o.id
      AND (ertad.review_has_scope(actor,o.id,u.id,'decision.read') OR ertad.review_has_scope(actor,o.id,u.id,'decision.vote')));
  ELSIF op='audiences' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',u.id,'name',u.name) ORDER BY u.name,u.id),'[]') INTO result
    FROM (SELECT * FROM ertad.units u WHERE u.organization_id=org AND u.kind='authority' AND u.status='active'
      AND ertad.review_has_scope(actor,org,u.id,'decision.manage') AND ertad.review_has_scope(actor,org,u.id,'decision.read') ORDER BY name,id LIMIT 250) u;
  ELSIF op='estimate' THEN
    SELECT COALESCE(array_agg(value::uuid),'{}'::uuid[]) INTO included_ids FROM jsonb_array_elements_text(input->'includedUnitIds');
    SELECT COALESCE(array_agg(value::uuid),'{}'::uuid[]) INTO excluded_ids FROM jsonb_array_elements_text(COALESCE(input->'excludedUnitIds','[]'::jsonb));
    req_floor := COALESCE((input->>'anonymousMinElectorate')::integer, policy_floor);
    IF cardinality(included_ids) NOT BETWEEN 1 AND 25 OR cardinality(excluded_ids) > 25 OR (included_ids && excluded_ids)
      OR req_floor NOT BETWEEN policy_floor AND 1000 THEN
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
    result := jsonb_build_object(
      'electorateCount', est_count,
      'meetsAnonymousFloor', est_count >= req_floor,
      'anonymousMinElectorate', req_floor,
      'policyMinElectorate', policy_floor
    );
  ELSIF op='list' THEN
    n := COALESCE((input->>'page')::integer,1); view_name := COALESCE(input->>'view','open');
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
      target := (input->>'unitId')::uuid;
    ELSE
      SELECT * INTO d FROM ertad.decisions WHERE organization_id=org AND id=(input->>'id')::uuid;
      IF NOT FOUND OR NOT ertad.decision_visible(actor,d) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
      target := d.unit_id;
    END IF;
    permission := CASE WHEN op IN ('create','update','cancel','nominate','withdraw_nomination') THEN 'decision.manage' WHEN op IN ('publish','close') THEN 'decision.publish' END;
    IF permission IS NOT NULL AND (NOT ertad.review_has_scope(actor,org,target,permission) OR NOT ertad.review_has_scope(actor,org,target,'decision.read')) THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied';
    END IF;
    IF op='vote' AND NOT EXISTS(SELECT 1 FROM ertad.decision_electorate e WHERE e.organization_id=org AND e.decision_id=d.id AND e.user_id=actor
      AND ertad.decision_eligible_audience(actor,org,d.unit_id,d.included_unit_ids,d.excluded_unit_ids,e.membership_id)) THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Not eligible';
    END IF;
    IF mutation THEN
      payload := CASE WHEN op='vote' AND d.privacy='anonymous' THEN '{"anonymous":true}'::jsonb ELSE input-'key' END;
      SELECT * INTO receipt FROM ertad.decision_commands WHERE organization_id=org AND actor_id=actor AND key=(input->>'key')::uuid;
      IF FOUND THEN
        IF receipt.operation<>op OR receipt.payload<>payload THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Retry conflict'; END IF;
        RETURN jsonb_build_object('data',receipt.response,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'decisionId',receipt.decision_id,'changed',false));
      END IF;
    END IF;

    IF op='detail' THEN
      result := ertad.decision_view(actor,d);
    ELSIF op IN ('create','update') THEN
      SELECT COALESCE(array_agg(trim(value) ORDER BY ordinality),'{}'::text[]) INTO opts FROM jsonb_array_elements_text(input->'options') WITH ORDINALITY;
      included_ids := CASE WHEN input ? 'includedUnitIds' THEN (SELECT COALESCE(array_agg(value::uuid),'{}'::uuid[]) FROM jsonb_array_elements_text(input->'includedUnitIds')) ELSE ARRAY[target] END;
      excluded_ids := CASE WHEN input ? 'excludedUnitIds' THEN (SELECT COALESCE(array_agg(value::uuid),'{}'::uuid[]) FROM jsonb_array_elements_text(input->'excludedUnitIds')) ELSE '{}'::uuid[] END;
      opens := (input->>'opensAt')::timestamptz; closes := (input->>'closesAt')::timestamptz;
      privacy_mode := COALESCE(input->>'privacy','named'); gov_mode := COALESCE(input->>'governanceMode','advisory');
      ref_labels := input->'referendumLabels';
      req_floor := (input->>'anonymousMinElectorate')::integer;
      IF privacy_mode NOT IN ('named','anonymous') OR gov_mode NOT IN ('advisory','binding_review')
      OR (req_floor IS NOT NULL AND req_floor NOT BETWEEN policy_floor AND 1000)
      OR (req_floor IS NOT NULL AND privacy_mode<>'anonymous')
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
        INSERT INTO ertad.decisions(organization_id,unit_id,creator_id,title,description,options,privacy,anonymous_min_electorate,quorum,opens_at,closes_at,kind,threshold,questions,included_unit_ids,excluded_unit_ids,governance_mode,referendum_labels)
        VALUES(org,target,actor,trim(input->>'title'),input->>'description',opts,privacy_mode,req_floor,(input->>'quorum')::integer,opens,closes,COALESCE(input->>'kind','poll'),(input->>'threshold')::integer,input->'questions',included_ids,excluded_ids,gov_mode,ref_labels)
        RETURNING * INTO d;
      ELSE
        IF d.status<>'draft' OR d.version IS DISTINCT FROM (input->>'version')::integer OR d.unit_id IS DISTINCT FROM (input->>'unitId')::uuid THEN
          RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Draft conflict';
        END IF;
        UPDATE ertad.decisions SET title=trim(input->>'title'),description=input->>'description',options=opts,privacy=privacy_mode,
          anonymous_min_electorate=req_floor,quorum=(input->>'quorum')::integer,
          opens_at=opens,closes_at=closes,kind=COALESCE(input->>'kind','poll'),threshold=(input->>'threshold')::integer,questions=input->'questions',
          included_unit_ids=included_ids,excluded_unit_ids=excluded_ids,governance_mode=gov_mode,referendum_labels=ref_labels,version=version+1
        WHERE organization_id=org AND id=d.id RETURNING * INTO d;
      END IF;
      changed := true; result := jsonb_build_object('id',d.id,'status',d.status);
    ELSIF op='nominate' THEN
      candidate_txt := trim(COALESCE(input->>'candidateLabel',''));
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
      changed := true; result := jsonb_build_object('id',d.id,'status',d.status);
    ELSIF op='withdraw_nomination' THEN
      candidate_txt := trim(COALESCE(input->>'candidateLabel',''));
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
      changed := true; result := jsonb_build_object('id',d.id,'status',d.status);
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
      eff_floor := GREATEST(COALESCE(d.anonymous_min_electorate, 0), policy_floor);
      INSERT INTO ertad.decision_electorate(organization_id,decision_id,user_id,membership_id)
      SELECT DISTINCT ON (m.user_id) org,d.id,m.user_id,m.id FROM ertad.memberships m
      WHERE m.organization_id=org AND ertad.decision_eligible_audience(m.user_id,org,d.unit_id,d.included_unit_ids,d.excluded_unit_ids,m.id)
      ORDER BY m.user_id,m.id;
      SELECT count(*) INTO n FROM ertad.decision_electorate WHERE organization_id=org AND decision_id=d.id;
      IF n = 0 THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Empty electorate'; END IF;
      IF d.privacy='anonymous' AND n < eff_floor THEN
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Anonymous audience below minimum privacy threshold';
      END IF;
      UPDATE ertad.decisions
      SET status='open',opened_at=clock_timestamp(),scope_path=ertad.unit_path(org,unit_id),
          anonymous_min_electorate=CASE WHEN d.privacy='anonymous' THEN eff_floor ELSE NULL END,version=version+1
      WHERE organization_id=org AND id=d.id RETURNING * INTO d;
      changed := true; result := jsonb_build_object('id',d.id,'status',CASE WHEN d.opens_at IS NOT NULL AND d.opens_at>clock_timestamp() THEN 'scheduled' ELSE 'open' END);
    ELSIF op IN ('close','cancel') THEN
      IF d.version IS DISTINCT FROM (input->>'version')::integer OR d.status NOT IN ('draft','open') OR (op='close' AND d.status<>'open')
      OR (op='cancel' AND d.status='open' AND d.closes_at<=clock_timestamp()) THEN
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='State conflict';
      END IF;
      UPDATE ertad.decisions SET status=CASE WHEN op='close' THEN 'closed' ELSE 'cancelled' END,closed_at=clock_timestamp(),version=version+1
      WHERE organization_id=org AND id=d.id RETURNING * INTO d;
      changed := true; result := jsonb_build_object('id',d.id,'status',d.status);
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
        chosen := (input->>'choice')::integer;
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
      changed := true; result := jsonb_build_object('id',d.id,'status','recorded');
    END IF;
    IF mutation THEN
      INSERT INTO ertad.decision_commands VALUES(org,actor,(input->>'key')::uuid,d.id,op,payload,result);
    END IF;
  END IF;
  RETURN jsonb_build_object('data',result,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'decisionId',d.id,'changed',changed));
END $$;

CREATE OR REPLACE FUNCTION ertad.decision_finish(sid uuid, token text, org uuid, did uuid, op text, changed boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid; d ertad.decisions; permission text; uid uuid; eff_floor integer;
BEGIN
  actor := ertad.review_identity(sid,token,true);
  SELECT * INTO d FROM ertad.decisions WHERE organization_id=org AND id=did;
  IF NOT FOUND OR NOT ertad.decision_visible(actor,d) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
  permission := CASE WHEN op IN ('create','update','cancel','nominate','withdraw_nomination') THEN 'decision.manage' WHEN op IN ('publish','close') THEN 'decision.publish' END;
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
  eff_floor := COALESCE(d.anonymous_min_electorate, ertad.anonymous_min_electorate());
  IF changed AND op='publish' AND (d.closes_at<=clock_timestamp() OR d.scope_path IS DISTINCT FROM ertad.unit_path(org,d.unit_id)
    OR (d.privacy='anonymous' AND (SELECT count(*) FROM ertad.decision_electorate WHERE organization_id=org AND decision_id=did) < eff_floor)) THEN
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

