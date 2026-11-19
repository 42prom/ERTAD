-- Web-only technical response. Grants are activated explicitly, never by migration.
ALTER TABLE ertad.platform_accounts DROP CONSTRAINT platform_accounts_permissions_check;
ALTER TABLE ertad.platform_accounts ADD CONSTRAINT platform_accounts_permissions_check
 CHECK (permissions <@ ARRAY['platform.read','platform.audit.read','platform.sessions.read','platform.sessions.revoke']::text[]
 AND array_position(permissions,NULL) IS NULL);

CREATE TABLE ertad.platform_session_responses (
 actor_id uuid NOT NULL REFERENCES ertad.platform_accounts(admin_user_id),
 request_id uuid NOT NULL,
 target_id uuid NOT NULL,
 reason text NOT NULL CHECK(reason IN ('suspected_compromise','operator_request','session_hygiene')),
 revoked_at timestamptz NOT NULL,
 PRIMARY KEY(actor_id,request_id)
);
-- Receipts survive normal expired-session cleanup; they contain no credentials or identity fields.
REVOKE ALL ON ertad.platform_session_responses FROM PUBLIC,ertad_app;

CREATE FUNCTION ertad.platform_session_command(sid uuid,token text,op text,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE account uuid; capabilities text[]; current_session ertad.admin_sessions;
 target ertad.admin_sessions; receipt ertad.platform_session_responses;
 target_id uuid:=(input->>'sessionId')::uuid; response_request_id uuid:=(input->>'requestId')::uuid;
 reason text:=input->>'reason'; before_id uuid:=(input->>'before')::uuid;
 session_kind text:=COALESCE(input->>'kind','all'); data jsonb; audit jsonb; active boolean;
BEGIN
 IF op NOT IN ('sessions','revoke') OR session_kind NOT IN ('all','technical','organization','unclassified') THEN
  RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid session command'; END IF;
 -- Reuse console session/account/grant locks and global audit ordering.
 PERFORM ertad.platform_console_command(sid,token,'overview','{}');
 SELECT * INTO current_session FROM ertad.admin_sessions WHERE id=sid;
 account:=current_session.admin_user_id;
 SELECT permissions INTO capabilities FROM ertad.platform_accounts WHERE admin_user_id=account;
 IF NOT ('platform.sessions.read'=ANY(capabilities)) OR
  (op='revoke' AND NOT ('platform.sessions.revoke'=ANY(capabilities))) THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 audit:=jsonb_build_object('adminUserId',account,'operation',op);
 IF op='sessions' THEN
  WITH selected AS (
   SELECT s.id,s.created_at,s.last_seen_at,s.idle_expires_at,s.absolute_expires_at,
    s.id=sid AS is_current,
    CASE WHEN EXISTS(SELECT 1 FROM ertad.platform_accounts p WHERE p.admin_user_id=s.admin_user_id) THEN 'technical'
     WHEN EXISTS(SELECT 1 FROM ertad.member_users m WHERE m.web_account_id=s.admin_user_id) THEN 'organization'
     ELSE 'unclassified' END AS kind
   FROM ertad.admin_sessions s JOIN ertad.admin_users a ON a.id=s.admin_user_id
   WHERE s.revoked_at IS NULL AND s.idle_expires_at>clock_timestamp() AND s.absolute_expires_at>clock_timestamp()
    AND a.is_active AND (a.locked_until IS NULL OR a.locked_until<=clock_timestamp())
    AND (before_id IS NULL OR s.id<before_id)
  ), filtered AS (SELECT * FROM selected s WHERE session_kind='all' OR s.kind=session_kind ORDER BY id DESC LIMIT 26),
  paged AS (SELECT * FROM filtered ORDER BY id DESC LIMIT 25)
  SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(jsonb_build_object(
   'id',id,'kind',p.kind,'current',is_current,'createdAt',created_at,'lastSeenAt',last_seen_at,
   'expiresAt',LEAST(idle_expires_at,absolute_expires_at)) ORDER BY id DESC) FROM paged p),'[]'),
   'nextBefore',CASE WHEN (SELECT count(*) FROM filtered)>25 THEN (SELECT id FROM paged ORDER BY id LIMIT 1) ELSE NULL END) INTO data;
 ELSE
  IF target_id IS NULL OR response_request_id IS NULL OR reason IS NULL OR
   reason NOT IN ('suspected_compromise','operator_request','session_hygiene') THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid session response'; END IF;
  IF target_id=sid THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Use ordinary logout for the current session'; END IF;
  IF current_session.step_up_expires_at IS NULL OR current_session.step_up_expires_at<=clock_timestamp() THEN
   RAISE EXCEPTION USING ERRCODE='P0428',MESSAGE='Fresh authentication required'; END IF;
  SELECT * INTO receipt FROM ertad.platform_session_responses r WHERE r.actor_id=account AND r.request_id=response_request_id;
  IF FOUND THEN
   IF receipt.target_id<>target_id OR receipt.reason<>reason THEN
    RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request key conflict'; END IF;
   RETURN jsonb_build_object('data',jsonb_build_object('sessionId',receipt.target_id,'revokedAt',receipt.revoked_at),'audit',NULL);
  END IF;
  SELECT * INTO target FROM ertad.admin_sessions WHERE id=target_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0404',MESSAGE='Session unavailable'; END IF;
  active:=target.revoked_at IS NULL AND target.idle_expires_at>clock_timestamp() AND target.absolute_expires_at>clock_timestamp();
  IF NOT active THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Session is no longer active'; END IF;
  UPDATE ertad.admin_sessions SET revoked_at=clock_timestamp(),step_up_expires_at=NULL WHERE id=target_id RETURNING * INTO target;
  INSERT INTO ertad.platform_session_responses VALUES(account,response_request_id,target_id,reason,target.revoked_at);
  data:=jsonb_build_object('sessionId',target_id,'revokedAt',target.revoked_at);
  audit:=audit||jsonb_build_object('targetSessionId',target_id,'requestId',response_request_id,'reason',reason);
 END IF;
 RETURN jsonb_build_object('data',data,'audit',audit);
END $$;
REVOKE ALL ON FUNCTION ertad.platform_session_command(uuid,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.platform_session_command(uuid,text,text,jsonb) TO ertad_app;

-- Extend sanitized journal projection with session-response events.
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
     AND a.event_type IN ('PLATFORM_BOOTSTRAPPED','PLATFORM_ACCESS_READ','PLATFORM_OVERVIEW_READ','PLATFORM_AUDIT_READ','PLATFORM_SESSIONS_READ','PLATFORM_SESSION_REVOKED','PLATFORM_SESSION_ACCESS_ENABLED',
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
