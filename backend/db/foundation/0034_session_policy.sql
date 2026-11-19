-- Technical configuration is separate from organization governance and grants no membership.
ALTER TABLE ertad.platform_accounts DROP CONSTRAINT platform_accounts_permissions_check;
ALTER TABLE ertad.platform_accounts ADD CONSTRAINT platform_accounts_permissions_check
 CHECK (permissions <@ ARRAY['platform.read','platform.audit.read','platform.sessions.read','platform.sessions.revoke',
 'platform.integrations.read','platform.integrations.test','platform.policy.read','platform.policy.propose','platform.policy.approve']::text[]
 AND array_position(permissions,NULL) IS NULL);

CREATE TABLE ertad.session_policy_proposals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 proposer_id uuid NOT NULL REFERENCES ertad.platform_accounts(admin_user_id),
 request_id uuid NOT NULL,
 expected_version integer NOT NULL CHECK(expected_version>=0),
 idle_seconds integer NOT NULL CHECK(idle_seconds BETWEEN 300 AND 3600),
 absolute_seconds integer NOT NULL CHECK(absolute_seconds BETWEEN 900 AND 86400),
 max_sessions integer NOT NULL CHECK(max_sessions BETWEEN 1 AND 10),
 reason text NOT NULL CHECK(reason IN ('security_tightening','session_usability','recovery')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','withdrawn')),
 reviewer_id uuid REFERENCES ertad.platform_accounts(admin_user_id),
 review_request_id uuid,
 reviewed_at timestamptz,
 version integer UNIQUE CHECK(version>0),
 UNIQUE(proposer_id,request_id), UNIQUE(reviewer_id,review_request_id),
 CHECK(idle_seconds<=absolute_seconds),
 CHECK((status='pending' AND reviewer_id IS NULL AND review_request_id IS NULL AND reviewed_at IS NULL)
  OR (status<>'pending' AND reviewer_id IS NOT NULL AND review_request_id IS NOT NULL AND reviewed_at IS NOT NULL)),
 CHECK((status='approved')=(version IS NOT NULL)),
 CHECK(status NOT IN ('approved','rejected') OR reviewer_id<>proposer_id),
 CHECK(status<>'withdrawn' OR reviewer_id=proposer_id)
);
REVOKE ALL ON ertad.session_policy_proposals FROM PUBLIC,ertad_app;
ALTER TABLE ertad.admin_sessions ADD COLUMN policy_idle_seconds integer CHECK(policy_idle_seconds BETWEEN 300 AND 3600);
ALTER TABLE ertad.admin_sessions ADD COLUMN policy_version integer REFERENCES ertad.session_policy_proposals(version);

-- Runtime receives only approved values. No proposal/actor disclosure or secret configuration.
CREATE FUNCTION ertad.current_session_policy() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE((SELECT jsonb_build_object('version',version,'idleSeconds',idle_seconds,
  'absoluteSeconds',absolute_seconds,'maxSessions',max_sessions)
 FROM ertad.session_policy_proposals WHERE status='approved' ORDER BY version DESC LIMIT 1),'null'::jsonb)
$$;
REVOKE ALL ON FUNCTION ertad.current_session_policy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.current_session_policy() TO ertad_app;

CREATE FUNCTION ertad.session_policy_command(sid uuid,token text,op text,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE account uuid; capabilities text[]; session_row ertad.admin_sessions;
 proposal ertad.session_policy_proposals; current_version integer; data jsonb; audit jsonb;
 request_key uuid:=(input->>'requestId')::uuid; proposal_id uuid:=(input->>'proposalId')::uuid;
 action text:=input->>'action'; cursor_id uuid:=(input->>'before')::uuid;
BEGIN
 IF op IS NULL OR op NOT IN ('sessionPolicy','proposeSessionPolicy','reviewSessionPolicy') THEN
  RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid policy command'; END IF;
 -- Console lock also serializes configuration writes with the required audit chain.
 PERFORM ertad.platform_console_command(sid,token,'overview','{}');
 SELECT * INTO session_row FROM ertad.admin_sessions WHERE id=sid;
 account:=session_row.admin_user_id;
 SELECT permissions INTO capabilities FROM ertad.platform_accounts WHERE admin_user_id=account;
 IF NOT ('platform.policy.read'=ANY(capabilities)) THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 current_version:=COALESCE((ertad.current_session_policy()->>'version')::integer,0);
 audit:=jsonb_build_object('adminUserId',account,'operation',op);
 IF op='sessionPolicy' THEN
  WITH selected AS (SELECT * FROM ertad.session_policy_proposals WHERE cursor_id IS NULL
   OR (created_at,id)<(SELECT created_at,id FROM ertad.session_policy_proposals WHERE id=cursor_id) ORDER BY created_at DESC,id DESC LIMIT 26),
  paged AS (SELECT * FROM selected ORDER BY created_at DESC,id DESC LIMIT 25)
  SELECT jsonb_build_object('current',ertad.current_session_policy(),
   'items',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'mine',proposer_id=account,
    'expectedVersion',expected_version,'version',version,'idleSeconds',idle_seconds,'absoluteSeconds',absolute_seconds,
    'maxSessions',max_sessions,'reason',reason,'createdAt',created_at,'expiresAt',expires_at,'reviewedAt',reviewed_at,
    'status',CASE WHEN status='pending' AND expires_at<=clock_timestamp() THEN 'expired' ELSE status END) ORDER BY created_at DESC,id DESC) FROM paged),'[]'),
   'nextBefore',CASE WHEN (SELECT count(*) FROM selected)>25 THEN (SELECT id FROM paged ORDER BY created_at,id LIMIT 1) ELSE NULL END) INTO data;
  RETURN jsonb_build_object('data',data,'audit',audit);
 END IF;
 IF session_row.step_up_expires_at IS NULL OR session_row.step_up_expires_at<=clock_timestamp() THEN
  RAISE EXCEPTION USING ERRCODE='P0428',MESSAGE='Fresh authentication required'; END IF;
 IF request_key IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Request key required'; END IF;
 IF op='proposeSessionPolicy' THEN
  IF NOT ('platform.policy.propose'=ANY(capabilities)) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
  IF input->>'expectedVersion' IS NULL OR input->>'idleSeconds' IS NULL OR input->>'absoluteSeconds' IS NULL OR input->>'maxSessions' IS NULL
   OR input->>'reason' IS NULL OR (input->>'idleSeconds')::integer NOT BETWEEN 300 AND 3600
   OR (input->>'absoluteSeconds')::integer NOT BETWEEN 900 AND 86400 OR (input->>'maxSessions')::integer NOT BETWEEN 1 AND 10
   OR (input->>'idleSeconds')::integer>(input->>'absoluteSeconds')::integer
   OR input->>'reason' NOT IN ('security_tightening','session_usability','recovery') THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid policy values'; END IF;
  SELECT * INTO proposal FROM ertad.session_policy_proposals WHERE proposer_id=account AND request_id=request_key;
  IF FOUND THEN
   IF proposal.expected_version<>(input->>'expectedVersion')::integer OR proposal.idle_seconds<>(input->>'idleSeconds')::integer
    OR proposal.absolute_seconds<>(input->>'absoluteSeconds')::integer OR proposal.max_sessions<>(input->>'maxSessions')::integer
    OR proposal.reason<>input->>'reason' THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request key conflict'; END IF;
   RETURN jsonb_build_object('data',jsonb_build_object('id',proposal.id),'audit',NULL);
  END IF;
  IF current_version<>(input->>'expectedVersion')::integer THEN
   RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Policy changed'; END IF;
  INSERT INTO ertad.session_policy_proposals(proposer_id,request_id,expected_version,idle_seconds,absolute_seconds,max_sessions,reason)
   VALUES(account,request_key,current_version,(input->>'idleSeconds')::integer,(input->>'absoluteSeconds')::integer,
    (input->>'maxSessions')::integer,input->>'reason') RETURNING * INTO proposal;
 ELSE
  IF proposal_id IS NULL OR action IS NULL OR action NOT IN ('approve','reject','withdraw') THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid review'; END IF;
  IF NOT (CASE WHEN action='withdraw' THEN 'platform.policy.propose' ELSE 'platform.policy.approve' END=ANY(capabilities)) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
  SELECT * INTO proposal FROM ertad.session_policy_proposals WHERE id=proposal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0404',MESSAGE='Proposal unavailable'; END IF;
  IF (action='withdraw' AND proposal.proposer_id<>account) OR (action<>'withdraw' AND proposal.proposer_id=account) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Independent review required'; END IF;
  -- Rechecked on the post-audit invocation as well, even after the row has been approved.
  IF action='approve' THEN
   PERFORM 1 FROM ertad.platform_accounts WHERE admin_user_id=proposal.proposer_id FOR SHARE;
   PERFORM 1 FROM ertad.admin_users WHERE id=proposal.proposer_id FOR SHARE;
   IF proposal.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Review deadline expired'; END IF;
  END IF;
  IF action='approve' AND NOT EXISTS(SELECT 1 FROM ertad.platform_accounts p JOIN ertad.admin_users a ON a.id=p.admin_user_id
   WHERE p.admin_user_id=proposal.proposer_id AND p.revoked_at IS NULL AND p.valid_from<=clock_timestamp() AND p.valid_until>clock_timestamp()
   AND ARRAY['platform.read','platform.policy.read','platform.policy.propose'] <@ p.permissions
   AND a.is_active AND (a.locked_until IS NULL OR a.locked_until<=clock_timestamp())) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Proposer authority unavailable'; END IF;
  IF proposal.review_request_id=request_key AND proposal.reviewer_id=account THEN
   IF proposal.status<>(CASE action WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE 'withdrawn' END) THEN
    RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request key conflict'; END IF;
   RETURN jsonb_build_object('data',jsonb_build_object('id',proposal.id),'audit',NULL);
  END IF;
  IF proposal.status<>'pending' OR (action<>'withdraw' AND proposal.expires_at<=clock_timestamp())
   OR (action='approve' AND proposal.expected_version<>current_version) THEN
   RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Proposal changed or expired'; END IF;
  UPDATE ertad.session_policy_proposals SET status=CASE action WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE 'withdrawn' END,
   reviewer_id=account,review_request_id=request_key,reviewed_at=clock_timestamp(),
   version=CASE WHEN action='approve' THEN current_version+1 ELSE NULL END WHERE id=proposal.id RETURNING * INTO proposal;
 END IF;
 RETURN jsonb_build_object('data',jsonb_build_object('id',proposal.id),
  'audit',audit||jsonb_build_object('proposalId',proposal.id,'status',proposal.status,'version',proposal.version));
END $$;
REVOKE ALL ON FUNCTION ertad.session_policy_command(uuid,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.session_policy_command(uuid,text,text,jsonb) TO ertad_app;

CREATE OR REPLACE FUNCTION ertad.platform_console_command(sid uuid,token text,op text,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE account uuid; grant_row ertad.platform_accounts; capabilities text[]:='{}'; data jsonb;
 before_id bigint:=(input->>'before')::bigint; category text:=COALESCE(input->>'category','all');
BEGIN
 IF op NOT IN ('access','overview','audit') OR before_id<1 OR category NOT IN ('all','access','authentication') THEN
  RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid platform query'; END IF;
 SELECT admin_user_id INTO account FROM ertad.admin_sessions WHERE id=sid AND token_hash=token FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 PERFORM 1 FROM ertad.admin_users WHERE id=account FOR SHARE;
 SELECT * INTO grant_row FROM ertad.platform_accounts WHERE admin_user_id=account FOR SHARE;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint);
 IF NOT EXISTS(SELECT 1 FROM ertad.admin_sessions s JOIN ertad.admin_users a ON a.id=s.admin_user_id
  WHERE s.id=sid AND s.token_hash=token AND s.revoked_at IS NULL AND s.idle_expires_at>clock_timestamp()
  AND s.absolute_expires_at>clock_timestamp() AND a.is_active AND (a.locked_until IS NULL OR a.locked_until<=clock_timestamp())) THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 IF grant_row.revoked_at IS NULL AND grant_row.valid_from<=clock_timestamp() AND grant_row.valid_until>clock_timestamp() THEN
  capabilities:=grant_row.permissions;
 END IF;
 IF op='access' THEN
  data:=jsonb_build_object('technicalAccount',grant_row.admin_user_id IS NOT NULL,'permissions',capabilities,'validUntil',grant_row.valid_until);
 ELSE
  IF NOT ('platform.read'=ANY(capabilities)) OR (op='audit' AND NOT ('platform.audit.read'=ANY(capabilities))) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
  IF op='overview' THEN
   data:=jsonb_build_object('checkedAt',clock_timestamp(),'validUntil',grant_row.valid_until,
    'migrations',(SELECT count(*) FROM ertad.schema_migrations),
    'ownActiveSessions',(SELECT count(*) FROM ertad.admin_sessions WHERE admin_user_id=account AND revoked_at IS NULL
     AND idle_expires_at>clock_timestamp() AND absolute_expires_at>clock_timestamp()));
  ELSE
   WITH selected AS (
    SELECT a.id,a.event_type,a.created_at FROM ertad.audit_log a
    WHERE (before_id IS NULL OR a.id<before_id)
     AND a.event_type IN ('PLATFORM_BOOTSTRAPPED','PLATFORM_ACCESS_READ','PLATFORM_OVERVIEW_READ','PLATFORM_AUDIT_READ','PLATFORM_SESSIONS_READ','PLATFORM_SESSION_REVOKED','PLATFORM_SESSION_ACCESS_ENABLED','PLATFORM_INTEGRATIONS_READ','PLATFORM_INTEGRATION_CHECK','PLATFORM_INTEGRATION_ACCESS_ENABLED','PLATFORM_SESSION_POLICY_READ','PLATFORM_SESSION_POLICY_PROPOSED','PLATFORM_SESSION_POLICY_REVIEWED','PLATFORM_POLICY_ACCESS_ENABLED',
      'ADMIN_LOGIN_SUCCEEDED','ADMIN_STEP_UP_GRANTED','ADMIN_STEP_UP_FAILED','ADMIN_LOGOUT')
     AND EXISTS(SELECT 1 FROM ertad.platform_accounts p WHERE p.admin_user_id::text=a.payload::jsonb->>'adminUserId')
     AND (category='all' OR (category='access' AND a.event_type LIKE 'PLATFORM_%') OR (category='authentication' AND a.event_type LIKE 'ADMIN_%'))
    ORDER BY a.id DESC LIMIT 26
   ), paged AS (SELECT * FROM selected ORDER BY id DESC LIMIT 25)
   SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id::text,'event',event_type,'at',created_at) ORDER BY id DESC) FROM paged),'[]'),
    'nextBefore',CASE WHEN (SELECT count(*) FROM selected)>25 THEN (SELECT min(id)::text FROM paged) ELSE NULL END) INTO data;
  END IF;
 END IF;
 RETURN jsonb_build_object('data',data,'audit',CASE WHEN grant_row.admin_user_id IS NOT NULL THEN jsonb_build_object('adminUserId',account,'operation',op) ELSE NULL END);
END $$;
