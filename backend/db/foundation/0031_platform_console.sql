-- Technical accounts are deliberately disjoint from organizational membership.
CREATE TABLE ertad.platform_accounts (
 admin_user_id uuid PRIMARY KEY REFERENCES ertad.admin_users(id),
 permissions text[] NOT NULL CHECK (permissions <@ ARRAY['platform.read','platform.audit.read']::text[] AND array_position(permissions,NULL) IS NULL),
 valid_from timestamptz NOT NULL DEFAULT now(),
 valid_until timestamptz NOT NULL,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (valid_until>valid_from)
);
CREATE FUNCTION ertad.guard_platform_account() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND NEW.admin_user_id<>OLD.admin_user_id) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Technical account classification is permanent; revoke its grants'; END IF;
 -- A real row update serializes both directions, including REPEATABLE READ writers.
 UPDATE ertad.admin_users SET updated_at=clock_timestamp() WHERE id=NEW.admin_user_id;
 IF EXISTS(SELECT 1 FROM ertad.member_users WHERE web_account_id=NEW.admin_user_id) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Organization accounts cannot become technical accounts'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER platform_account_guard BEFORE INSERT OR UPDATE OR DELETE ON ertad.platform_accounts
 FOR EACH ROW EXECUTE FUNCTION ertad.guard_platform_account();
CREATE FUNCTION ertad.guard_member_account_class() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.web_account_id IS NOT NULL THEN
  UPDATE ertad.admin_users SET updated_at=clock_timestamp() WHERE id=NEW.web_account_id;
  IF EXISTS(SELECT 1 FROM ertad.platform_accounts WHERE admin_user_id=NEW.web_account_id) THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Technical accounts cannot acquire organization membership'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER member_account_class_guard BEFORE INSERT OR UPDATE OF web_account_id ON ertad.member_users
 FOR EACH ROW EXECUTE FUNCTION ertad.guard_member_account_class();

CREATE INDEX audit_technical_events_cursor ON ertad.audit_log(id DESC)
 WHERE event_type IN ('PLATFORM_BOOTSTRAPPED','PLATFORM_ACCESS_READ','PLATFORM_OVERVIEW_READ','PLATFORM_AUDIT_READ',
 'ADMIN_LOGIN_SUCCEEDED','ADMIN_STEP_UP_GRANTED','ADMIN_STEP_UP_FAILED','ADMIN_LOGOUT');

CREATE FUNCTION ertad.platform_console_command(sid uuid,token text,op text,input jsonb) RETURNS jsonb
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
     AND a.event_type IN ('PLATFORM_BOOTSTRAPPED','PLATFORM_ACCESS_READ','PLATFORM_OVERVIEW_READ','PLATFORM_AUDIT_READ',
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
REVOKE ALL ON ertad.platform_accounts FROM PUBLIC,ertad_app;
REVOKE ALL ON FUNCTION ertad.guard_platform_account(),ertad.guard_member_account_class() FROM PUBLIC,ertad_app;
REVOKE ALL ON FUNCTION ertad.platform_console_command(uuid,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.platform_console_command(uuid,text,text,jsonb) TO ertad_app;
