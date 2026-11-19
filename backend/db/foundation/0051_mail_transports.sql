-- Explicit delivery opt-in and reviewed SMTP configuration. Existing policies stay non-delivering.
ALTER TABLE ertad.mail_policy_proposals
 ADD COLUMN delivery_enabled boolean NOT NULL DEFAULT false,
 ADD COLUMN public_origin text NOT NULL DEFAULT '',
 ADD COLUMN smtp_service text NOT NULL DEFAULT 'sendgrid' CHECK(smtp_service IN ('sendgrid','gmail','office365')),
 ADD COLUMN smtp_user text NOT NULL DEFAULT '' CHECK(length(smtp_user)<=254 AND smtp_user !~ '[[:cntrl:]]');
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='ertad.mail_policy_proposals'::regclass AND contype='c'
 AND (pg_get_constraintdef(oid) LIKE '%provider%' OR pg_get_constraintdef(oid) LIKE '%mode%') LOOP
 EXECUTE format('ALTER TABLE ertad.mail_policy_proposals DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE ertad.mail_policy_proposals
 ADD CHECK(provider IN ('none','sendgrid','smtp')),
 ADD CHECK(mode IN ('off','enabled')),
 ADD CHECK(provider<>'none' OR (mode='off' AND credential_cipher IS NULL AND NOT delivery_enabled)),
 ADD CHECK(mode<>'enabled' OR (provider IN ('sendgrid','smtp') AND credential_cipher IS NOT NULL AND sender_email<>'')),
 ADD CHECK(provider<>'smtp' OR mode='off' OR smtp_user<>''),
 ADD CHECK(length(public_origin)<=260 AND (public_origin='' OR public_origin ~ '^https://[a-z0-9][a-z0-9.-]*[a-z0-9]$')),
 ADD CHECK(NOT delivery_enabled OR (mode='enabled' AND public_origin<>''));
CREATE OR REPLACE FUNCTION ertad.current_mail_policy() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE((SELECT jsonb_build_object('version',version,'provider',provider,'mode',mode,
  'deliveryEnabled',delivery_enabled,'publicOrigin',public_origin,'smtpService',smtp_service,'smtpUser',smtp_user,'senderName',sender_name,'senderEmail',sender_email,'hasCredential',credential_cipher IS NOT NULL,'credentialCipher',credential_cipher)
 FROM ertad.mail_policy_proposals WHERE status='approved' ORDER BY version DESC LIMIT 1),
 '{"deliveryEnabled":false,"publicOrigin":"","smtpService":"sendgrid","smtpUser":"","version":0,"provider":"none","mode":"off","senderName":"","senderEmail":"","hasCredential":false,"credentialCipher":null}'::jsonb)
$$;
REVOKE ALL ON FUNCTION ertad.current_mail_policy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.current_mail_policy() TO ertad_app;

CREATE OR REPLACE FUNCTION ertad.mail_policy_command(sid uuid,token text,op text,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE account uuid; capabilities text[]; session_row ertad.admin_sessions;
 proposal ertad.mail_policy_proposals; effective_cipher text; effective_digest text; current_version integer; data jsonb; audit jsonb;
 request_key uuid:=(input->>'requestId')::uuid; proposal_id uuid:=(input->>'proposalId')::uuid;
 action text:=input->>'action'; cursor_id uuid:=(input->>'before')::uuid;
BEGIN
 IF op IS NULL OR op NOT IN ('mailPolicy','proposeMailPolicy','reviewMailPolicy','mailCheck') THEN
  RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid policy command'; END IF;
 -- Console lock also serializes configuration writes with the required audit chain.
 PERFORM ertad.platform_console_command(sid,token,'overview','{}');
 SELECT * INTO session_row FROM ertad.admin_sessions WHERE id=sid;
 account:=session_row.admin_user_id;
 SELECT permissions INTO capabilities FROM ertad.platform_accounts WHERE admin_user_id=account;
 IF NOT ('platform.providers.read'=ANY(capabilities)) THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 current_version:=COALESCE((ertad.current_mail_policy()->>'version')::integer,0);
 audit:=jsonb_build_object('adminUserId',account,'operation',op);
 IF op='mailPolicy' THEN
  WITH selected AS (SELECT * FROM ertad.mail_policy_proposals WHERE cursor_id IS NULL
   OR (created_at,id)<(SELECT created_at,id FROM ertad.mail_policy_proposals WHERE id=cursor_id) ORDER BY created_at DESC,id DESC LIMIT 26),
  paged AS (SELECT * FROM selected ORDER BY created_at DESC,id DESC LIMIT 25)
  SELECT jsonb_build_object('current',ertad.current_mail_policy()-'credentialCipher',
   'items',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'mine',proposer_id=account,
    'expectedVersion',expected_version,'version',version,'provider',provider,'mode',mode,'deliveryEnabled',delivery_enabled,'publicOrigin',public_origin,'smtpService',smtp_service,'smtpUser',smtp_user,'senderName',sender_name,'senderEmail',sender_email,'hasCredential',credential_cipher IS NOT NULL,'reason',reason,'createdAt',created_at,'expiresAt',expires_at,'reviewedAt',reviewed_at,
    'status',CASE WHEN status='pending' AND expires_at<=clock_timestamp() THEN 'expired' ELSE status END) ORDER BY created_at DESC,id DESC) FROM paged),'[]'),
   'nextBefore',CASE WHEN (SELECT count(*) FROM selected)>25 THEN (SELECT id FROM paged ORDER BY created_at,id LIMIT 1) ELSE NULL END) INTO data;
  RETURN jsonb_build_object('data',data,'audit',audit);
 END IF;
 IF session_row.step_up_expires_at IS NULL OR session_row.step_up_expires_at<=clock_timestamp() THEN
  RAISE EXCEPTION USING ERRCODE='P0428',MESSAGE='Fresh authentication required'; END IF;
 IF op='mailCheck' THEN
  IF NOT ('platform.integrations.test'=ANY(capabilities)) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
  IF input->>'expectedVersion' IS NULL OR (input->>'expectedVersion')::integer<>current_version THEN
   RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Policy changed'; END IF;
  IF input->>'status' IS NULL OR input->>'status' NOT IN ('requested','valid','unavailable','off') THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid diagnostic status'; END IF;
  RETURN jsonb_build_object('data',jsonb_build_object('version',current_version,'status',input->>'status'),
   'audit',audit||jsonb_build_object('status',input->>'status','version',current_version));
 END IF;
 IF request_key IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Request key required'; END IF;
 IF op='proposeMailPolicy' THEN
  IF NOT ('platform.providers.propose'=ANY(capabilities)) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
  IF input->>'expectedVersion' IS NULL OR input->>'provider' IS NULL OR input->>'provider' NOT IN ('none','sendgrid','smtp')
   OR input->>'mode' IS NULL OR input->>'mode' NOT IN ('off','enabled') OR jsonb_typeof(input->'senderName') IS DISTINCT FROM 'string' OR jsonb_typeof(input->'senderEmail') IS DISTINCT FROM 'string'
   OR input->>'reason' IS NULL OR input->>'reason' NOT IN ('security_tightening','provider_change','recovery') THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid provider values'; END IF;
  SELECT * INTO proposal FROM ertad.mail_policy_proposals WHERE proposer_id=account AND request_id=request_key;
  IF FOUND THEN
   IF proposal.expected_version<>(input->>'expectedVersion')::integer OR proposal.provider<>input->>'provider'
    OR proposal.mode<>input->>'mode' OR proposal.sender_name<>input->>'senderName' OR proposal.sender_email<>input->>'senderEmail'
    OR proposal.delivery_enabled IS DISTINCT FROM (input->>'deliveryEnabled')::boolean OR proposal.public_origin IS DISTINCT FROM input->>'publicOrigin' OR proposal.smtp_service IS DISTINCT FROM input->>'smtpService' OR proposal.smtp_user IS DISTINCT FROM input->>'smtpUser'
    OR proposal.credential_input_digest IS DISTINCT FROM input->>'credentialDigest'
    OR proposal.reason<>input->>'reason' THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request key conflict'; END IF;
   RETURN jsonb_build_object('data',jsonb_build_object('id',proposal.id),'audit',NULL);
  END IF;
  IF current_version<>(input->>'expectedVersion')::integer THEN
   RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Policy changed'; END IF;
  -- Empty credential input retains the approved key captured by this version. None clears it.
  IF input->>'provider' IN ('sendgrid','smtp') THEN
   SELECT credential_cipher,credential_digest INTO effective_cipher,effective_digest FROM ertad.mail_policy_proposals
     WHERE status='approved' AND provider=input->>'provider' AND (provider<>'smtp' OR (smtp_service=input->>'smtpService' AND smtp_user=input->>'smtpUser')) AND version=current_version;
   IF input->>'credentialCipher' IS NOT NULL THEN
     effective_cipher:=input->>'credentialCipher'; effective_digest:=input->>'credentialDigest';
   END IF;
  END IF;
  IF (input->>'mode'='enabled' AND (input->>'provider' NOT IN ('sendgrid','smtp') OR effective_cipher IS NULL)) THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Provider credential required'; END IF;
  INSERT INTO ertad.mail_policy_proposals(proposer_id,request_id,expected_version,provider,mode,delivery_enabled,public_origin,smtp_service,smtp_user,sender_name,sender_email,credential_cipher,credential_digest,credential_input_digest,reason)
   VALUES(account,request_key,current_version,input->>'provider',input->>'mode',(input->>'deliveryEnabled')::boolean,input->>'publicOrigin',input->>'smtpService',input->>'smtpUser',input->>'senderName',input->>'senderEmail',
    effective_cipher,effective_digest,input->>'credentialDigest',input->>'reason') RETURNING * INTO proposal;
 ELSE
  IF proposal_id IS NULL OR action IS NULL OR action NOT IN ('approve','reject','withdraw') THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid review'; END IF;
  IF NOT (CASE WHEN action='withdraw' THEN 'platform.providers.propose' ELSE 'platform.providers.approve' END=ANY(capabilities)) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
  SELECT * INTO proposal FROM ertad.mail_policy_proposals WHERE id=proposal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0404',MESSAGE='Proposal unavailable'; END IF;
  IF (action='withdraw' AND proposal.proposer_id<>account) OR (action<>'withdraw' AND proposal.proposer_id=account) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Independent review required'; END IF;
  -- Rechecked on the post-audit invocation as well, even after the row has been approved.
  IF action='approve' THEN
   -- The fixed-origin mail adapter is available in this composition. No delivery is triggered by approval.
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
  UPDATE ertad.mail_policy_proposals SET status=CASE action WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE 'withdrawn' END,
   reviewer_id=account,review_request_id=request_key,reviewed_at=clock_timestamp(),
   version=CASE WHEN action='approve' THEN current_version+1 ELSE NULL END WHERE id=proposal.id RETURNING * INTO proposal;
 END IF;
 RETURN jsonb_build_object('data',jsonb_build_object('id',proposal.id),
  'audit',audit||jsonb_build_object('proposalId',proposal.id,'status',proposal.status,'version',proposal.version));
END $$;
REVOKE ALL ON FUNCTION ertad.mail_policy_command(uuid,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.mail_policy_command(uuid,text,text,jsonb) TO ertad_app;

