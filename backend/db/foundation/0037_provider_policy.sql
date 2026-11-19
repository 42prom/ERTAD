ALTER TABLE ertad.platform_accounts DROP CONSTRAINT platform_accounts_permissions_check;
ALTER TABLE ertad.platform_accounts ADD CONSTRAINT platform_accounts_permissions_check CHECK
 (permissions <@ ARRAY['platform.read','platform.audit.read','platform.sessions.read','platform.sessions.revoke',
 'platform.integrations.read','platform.integrations.test','platform.policy.read','platform.policy.propose','platform.policy.approve',
 'platform.network.read','platform.network.propose','platform.network.approve','platform.limits.read','platform.limits.propose','platform.limits.approve','platform.providers.read','platform.providers.propose','platform.providers.approve']::text[] AND array_position(permissions,NULL) IS NULL);

CREATE TABLE ertad.provider_policy_proposals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 proposer_id uuid NOT NULL REFERENCES ertad.platform_accounts(admin_user_id),
 request_id uuid NOT NULL,
 expected_version integer NOT NULL CHECK(expected_version>=0),
 provider text NOT NULL CHECK(provider IN ('none','iphub')),
 mode text NOT NULL CHECK(mode IN ('off','enforce')),
 block_suspicious boolean NOT NULL,
 credential_cipher text,
 credential_digest text,
 credential_input_digest text,
 CHECK((credential_cipher IS NULL)=(credential_digest IS NULL)),
 CHECK(credential_cipher IS NULL OR (length(credential_cipher) BETWEEN 60 AND 1200 AND credential_cipher LIKE 'v2:%' AND credential_digest ~ '^[a-f0-9]{64}$')),
 CHECK(credential_input_digest IS NULL OR credential_input_digest ~ '^[a-f0-9]{64}$'),
 CHECK(provider<>'none' OR (mode='off' AND credential_cipher IS NULL)),
 CHECK(mode<>'enforce' OR (provider='iphub' AND credential_cipher IS NOT NULL)),
 reason text NOT NULL CHECK(reason IN ('security_tightening','provider_change','recovery')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','withdrawn')),
 reviewer_id uuid REFERENCES ertad.platform_accounts(admin_user_id),
 review_request_id uuid,
 reviewed_at timestamptz,
 version integer UNIQUE CHECK(version>0),
 UNIQUE(proposer_id,request_id), UNIQUE(reviewer_id,review_request_id),
 CHECK((status='pending' AND reviewer_id IS NULL AND review_request_id IS NULL AND reviewed_at IS NULL)
  OR (status<>'pending' AND reviewer_id IS NOT NULL AND review_request_id IS NOT NULL AND reviewed_at IS NOT NULL)),
 CHECK((status='approved')=(version IS NOT NULL)),
 CHECK(status NOT IN ('approved','rejected') OR reviewer_id<>proposer_id),
 CHECK(status<>'withdrawn' OR reviewer_id=proposer_id)
);
REVOKE ALL ON ertad.provider_policy_proposals FROM PUBLIC,ertad_app;

-- Internal runtime receives approved ciphertext. Console projections omit ciphertext and fingerprints.
CREATE FUNCTION ertad.current_provider_policy() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE((SELECT jsonb_build_object('version',version,'provider',provider,'mode',mode,
  'blockSuspicious',block_suspicious,'hasCredential',credential_cipher IS NOT NULL,'credentialCipher',credential_cipher)
 FROM ertad.provider_policy_proposals WHERE status='approved' ORDER BY version DESC LIMIT 1),
 '{"version":0,"provider":"none","mode":"off","blockSuspicious":false,"hasCredential":false,"credentialCipher":null}'::jsonb)
$$;
REVOKE ALL ON FUNCTION ertad.current_provider_policy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.current_provider_policy() TO ertad_app;

CREATE FUNCTION ertad.provider_policy_command(sid uuid,token text,op text,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE account uuid; capabilities text[]; session_row ertad.admin_sessions;
 proposal ertad.provider_policy_proposals; effective_cipher text; effective_digest text; current_version integer; data jsonb; audit jsonb;
 request_key uuid:=(input->>'requestId')::uuid; proposal_id uuid:=(input->>'proposalId')::uuid;
 action text:=input->>'action'; cursor_id uuid:=(input->>'before')::uuid;
BEGIN
 IF op IS NULL OR op NOT IN ('providerPolicy','proposeProviderPolicy','reviewProviderPolicy') THEN
  RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid policy command'; END IF;
 -- Console lock also serializes configuration writes with the required audit chain.
 PERFORM ertad.platform_console_command(sid,token,'overview','{}');
 SELECT * INTO session_row FROM ertad.admin_sessions WHERE id=sid;
 account:=session_row.admin_user_id;
 SELECT permissions INTO capabilities FROM ertad.platform_accounts WHERE admin_user_id=account;
 IF NOT ('platform.providers.read'=ANY(capabilities)) THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 current_version:=COALESCE((ertad.current_provider_policy()->>'version')::integer,0);
 audit:=jsonb_build_object('adminUserId',account,'operation',op);
 IF op='providerPolicy' THEN
  WITH selected AS (SELECT * FROM ertad.provider_policy_proposals WHERE cursor_id IS NULL
   OR (created_at,id)<(SELECT created_at,id FROM ertad.provider_policy_proposals WHERE id=cursor_id) ORDER BY created_at DESC,id DESC LIMIT 26),
  paged AS (SELECT * FROM selected ORDER BY created_at DESC,id DESC LIMIT 25)
  SELECT jsonb_build_object('current',ertad.current_provider_policy()-'credentialCipher',
   'items',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'mine',proposer_id=account,
    'expectedVersion',expected_version,'version',version,'provider',provider,'mode',mode,'blockSuspicious',block_suspicious,'hasCredential',credential_cipher IS NOT NULL,'reason',reason,'createdAt',created_at,'expiresAt',expires_at,'reviewedAt',reviewed_at,
    'status',CASE WHEN status='pending' AND expires_at<=clock_timestamp() THEN 'expired' ELSE status END) ORDER BY created_at DESC,id DESC) FROM paged),'[]'),
   'nextBefore',CASE WHEN (SELECT count(*) FROM selected)>25 THEN (SELECT id FROM paged ORDER BY created_at,id LIMIT 1) ELSE NULL END) INTO data;
  RETURN jsonb_build_object('data',data,'audit',audit);
 END IF;
 IF session_row.step_up_expires_at IS NULL OR session_row.step_up_expires_at<=clock_timestamp() THEN
  RAISE EXCEPTION USING ERRCODE='P0428',MESSAGE='Fresh authentication required'; END IF;
 IF request_key IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Request key required'; END IF;
 IF op='proposeProviderPolicy' THEN
  IF NOT ('platform.providers.propose'=ANY(capabilities)) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
  IF input->>'expectedVersion' IS NULL OR input->>'provider' IS NULL OR input->>'provider' NOT IN ('none','iphub')
   OR input->>'mode' IS NULL OR input->>'mode' NOT IN ('off','enforce') OR jsonb_typeof(input->'blockSuspicious') IS DISTINCT FROM 'boolean'
   OR input->>'reason' IS NULL OR input->>'reason' NOT IN ('security_tightening','provider_change','recovery') THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid provider values'; END IF;
  SELECT * INTO proposal FROM ertad.provider_policy_proposals WHERE proposer_id=account AND request_id=request_key;
  IF FOUND THEN
   IF proposal.expected_version<>(input->>'expectedVersion')::integer OR proposal.provider<>input->>'provider'
    OR proposal.mode<>input->>'mode' OR proposal.block_suspicious<>(input->>'blockSuspicious')::boolean
    OR proposal.credential_input_digest IS DISTINCT FROM input->>'credentialDigest'
    OR proposal.reason<>input->>'reason' THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request key conflict'; END IF;
   RETURN jsonb_build_object('data',jsonb_build_object('id',proposal.id),'audit',NULL);
  END IF;
  IF current_version<>(input->>'expectedVersion')::integer THEN
   RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Policy changed'; END IF;
  -- Empty credential input retains the approved key captured by this version. None clears it.
  IF input->>'provider'='iphub' THEN
   SELECT credential_cipher,credential_digest INTO effective_cipher,effective_digest FROM ertad.provider_policy_proposals
     WHERE status='approved' ORDER BY version DESC LIMIT 1;
   IF input->>'credentialCipher' IS NOT NULL THEN
     effective_cipher:=input->>'credentialCipher'; effective_digest:=input->>'credentialDigest';
   END IF;
  END IF;
  IF (input->>'mode'='enforce' AND (input->>'provider'<>'iphub' OR effective_cipher IS NULL)) THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Provider credential required'; END IF;
  INSERT INTO ertad.provider_policy_proposals(proposer_id,request_id,expected_version,provider,mode,block_suspicious,credential_cipher,credential_digest,credential_input_digest,reason)
   VALUES(account,request_key,current_version,input->>'provider',input->>'mode',(input->>'blockSuspicious')::boolean,
    effective_cipher,effective_digest,input->>'credentialDigest',input->>'reason') RETURNING * INTO proposal;
 ELSE
  IF proposal_id IS NULL OR action IS NULL OR action NOT IN ('approve','reject','withdraw') THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid review'; END IF;
  IF NOT (CASE WHEN action='withdraw' THEN 'platform.providers.propose' ELSE 'platform.providers.approve' END=ANY(capabilities)) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
  SELECT * INTO proposal FROM ertad.provider_policy_proposals WHERE id=proposal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0404',MESSAGE='Proposal unavailable'; END IF;
  IF (action='withdraw' AND proposal.proposer_id<>account) OR (action<>'withdraw' AND proposal.proposer_id=account) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Independent review required'; END IF;
  -- Rechecked on the post-audit invocation as well, even after the row has been approved.
  IF action='approve' THEN
   IF proposal.mode='enforce' AND (input->>'runtimeReady') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Trusted ingress required'; END IF;
   PERFORM 1 FROM ertad.platform_accounts WHERE admin_user_id=proposal.proposer_id FOR SHARE;
   PERFORM 1 FROM ertad.admin_users WHERE id=proposal.proposer_id FOR SHARE;
   IF proposal.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Review deadline expired'; END IF;
  END IF;
  IF action='approve' AND NOT EXISTS(SELECT 1 FROM ertad.platform_accounts p JOIN ertad.admin_users a ON a.id=p.admin_user_id
   WHERE p.admin_user_id=proposal.proposer_id AND p.revoked_at IS NULL AND p.valid_from<=clock_timestamp() AND p.valid_until>clock_timestamp()
   AND ARRAY['platform.read','platform.providers.read','platform.providers.propose'] <@ p.permissions
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
  UPDATE ertad.provider_policy_proposals SET status=CASE action WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE 'withdrawn' END,
   reviewer_id=account,review_request_id=request_key,reviewed_at=clock_timestamp(),
   version=CASE WHEN action='approve' THEN current_version+1 ELSE NULL END WHERE id=proposal.id RETURNING * INTO proposal;
 END IF;
 RETURN jsonb_build_object('data',jsonb_build_object('id',proposal.id),
  'audit',audit||jsonb_build_object('proposalId',proposal.id,'status',proposal.status,'version',proposal.version));
END $$;
REVOKE ALL ON FUNCTION ertad.provider_policy_command(uuid,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.provider_policy_command(uuid,text,text,jsonb) TO ertad_app;

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
     AND a.event_type IN ('PLATFORM_PROVIDER_POLICY_READ','PLATFORM_PROVIDER_POLICY_PROPOSED','PLATFORM_PROVIDER_POLICY_REVIEWED','PLATFORM_PROVIDER_ACCESS_ENABLED','PLATFORM_BOOTSTRAPPED','PLATFORM_ACCESS_READ','PLATFORM_OVERVIEW_READ','PLATFORM_AUDIT_READ','PLATFORM_SESSIONS_READ','PLATFORM_SESSION_REVOKED','PLATFORM_SESSION_ACCESS_ENABLED','PLATFORM_INTEGRATIONS_READ','PLATFORM_INTEGRATION_CHECK','PLATFORM_INTEGRATION_ACCESS_ENABLED','PLATFORM_NETWORK_POLICY_READ','PLATFORM_NETWORK_POLICY_PROPOSED','PLATFORM_NETWORK_POLICY_REVIEWED','PLATFORM_NETWORK_ACCESS_ENABLED','PLATFORM_SECURITY_LIMITS_READ','PLATFORM_SECURITY_LIMITS_PROPOSED','PLATFORM_SECURITY_LIMITS_REVIEWED','PLATFORM_LIMITS_ACCESS_ENABLED','PLATFORM_SESSION_POLICY_READ','PLATFORM_SESSION_POLICY_PROPOSED','PLATFORM_SESSION_POLICY_REVIEWED','PLATFORM_POLICY_ACCESS_ENABLED',
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
