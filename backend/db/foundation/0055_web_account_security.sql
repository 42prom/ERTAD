-- Technical containment is separate from organizational membership and account activation.
ALTER TABLE ertad.platform_accounts DROP CONSTRAINT platform_accounts_permissions_check;
ALTER TABLE ertad.platform_accounts ADD CONSTRAINT platform_accounts_permissions_check CHECK
 (permissions <@ ARRAY['platform.read','platform.audit.read','platform.sessions.read','platform.sessions.revoke',
 'platform.integrations.read','platform.integrations.test','platform.policy.read','platform.policy.propose','platform.policy.approve',
 'platform.network.read','platform.network.propose','platform.network.approve','platform.limits.read','platform.limits.propose','platform.limits.approve',
 'platform.providers.read','platform.providers.propose','platform.providers.approve',
 'platform.accounts.read','platform.accounts.hold','platform.accounts.release']::text[] AND array_position(permissions,NULL) IS NULL);

CREATE TABLE ertad.web_account_security_holds (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES ertad.admin_users(id),
 actor_id uuid NOT NULL REFERENCES ertad.platform_accounts(admin_user_id), request_id uuid NOT NULL,
 reason text NOT NULL CHECK(reason IN ('suspected_compromise','credential_exposure')),
 credential_fingerprint text NOT NULL CHECK(credential_fingerprint ~ '^[a-f0-9]{64}$'),
 held_at timestamptz NOT NULL DEFAULT clock_timestamp(), released_at timestamptz,
 released_by uuid REFERENCES ertad.platform_accounts(admin_user_id), release_request_id uuid,
 UNIQUE(actor_id,request_id), UNIQUE(released_by,release_request_id),
 CHECK((released_at IS NULL AND released_by IS NULL AND release_request_id IS NULL)
 OR (released_at IS NOT NULL AND released_by IS NOT NULL AND release_request_id IS NOT NULL AND released_by<>actor_id AND released_by<>account_id)),
 CHECK(actor_id<>account_id AND (released_at IS NULL OR released_at>=held_at))
);
CREATE UNIQUE INDEX web_security_hold_active ON ertad.web_account_security_holds(account_id) WHERE released_at IS NULL;
CREATE INDEX web_security_hold_history ON ertad.web_account_security_holds(account_id,held_at DESC,id);
REVOKE ALL ON ertad.web_account_security_holds FROM PUBLIC,ertad_app;

CREATE FUNCTION ertad.web_account_held(account uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM ertad.web_account_security_holds WHERE account_id=account AND released_at IS NULL)
$$;
REVOKE ALL ON FUNCTION ertad.web_account_held(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.web_account_held(uuid) TO ertad_app;

-- This development slice must not strand unprovisioned/bootstrap/MFA accounts.
CREATE FUNCTION ertad.web_security_recoverable(account uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM ertad.web_invite_contacts c WHERE ertad.web_recovery_eligible(account,c.organization_id,c.id))
$$;
REVOKE ALL ON FUNCTION ertad.web_security_recoverable(uuid) FROM PUBLIC,ertad_app;

-- Reusing a revoked session through direct runtime SQL must not bypass containment.
CREATE FUNCTION ertad.guard_held_web_session() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.revoked_at IS NULL THEN
  PERFORM 1 FROM ertad.admin_users WHERE id=NEW.admin_user_id FOR SHARE;
  IF ertad.web_account_held(NEW.admin_user_id) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Session unavailable'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ertad.guard_held_web_session() FROM PUBLIC,ertad_app;
CREATE TRIGGER held_web_session BEFORE INSERT OR UPDATE OF revoked_at,admin_user_id ON ertad.admin_sessions
 FOR EACH ROW EXECUTE FUNCTION ertad.guard_held_web_session();

CREATE FUNCTION ertad.web_security_actor(sid uuid,token text,op text) RETURNS uuid
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE actor uuid; capabilities text[]; s ertad.admin_sessions;
BEGIN
 PERFORM ertad.platform_console_command(sid,token,'overview','{}');
 SELECT * INTO s FROM ertad.admin_sessions WHERE id=sid AND token_hash=token;
 actor:=s.admin_user_id;
 SELECT permissions INTO capabilities FROM ertad.platform_accounts WHERE admin_user_id=actor;
 IF NOT COALESCE('platform.accounts.read'=ANY(capabilities),false)
 OR (op<>'list' AND NOT COALESCE(('platform.accounts.'||op)=ANY(capabilities),false)) THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 IF op<>'list' AND (s.step_up_expires_at IS NULL OR s.step_up_expires_at<=clock_timestamp()) THEN
  RAISE EXCEPTION USING ERRCODE='P0428',MESSAGE='Fresh authentication required'; END IF;
 RETURN actor;
END $$;
REVOKE ALL ON FUNCTION ertad.web_security_actor(uuid,text,text) FROM PUBLIC,ertad_app;

CREATE FUNCTION ertad.web_account_security_command(sid uuid,token text,op text,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid; a ertad.admin_users; h ertad.web_account_security_holds; target uuid;
 key uuid:=(input->>'requestId')::uuid; before_id uuid:=(input->>'before')::uuid;
 filter_state text:=COALESCE(input->>'state','all'); audit jsonb; data jsonb; changed boolean:=false; stamp timestamptz;
BEGIN
 IF op IS NULL OR op NOT IN ('list','hold','release') OR filter_state NOT IN ('all','held','available') THEN
  RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid account security operation'; END IF;
 IF op<>'list' THEN
  target:=CASE WHEN op='hold' THEN (input->>'accountId')::uuid ELSE
   (SELECT account_id FROM ertad.web_account_security_holds WHERE id=(input->>'holdId')::uuid) END;
  SELECT * INTO a FROM ertad.admin_users WHERE id=target FOR UPDATE;
 END IF;
 actor:=ertad.web_security_actor(sid,token,op);
 audit:=jsonb_build_object('adminUserId',actor,'operation',op);
 IF op='list' THEN
  WITH selected AS (
   SELECT u.id,u.is_active,u.created_at,hold_row.id hold_id,hold_row.actor_id,hold_row.held_at,hold_row.reason,
   COALESCE(hold_row.id IS NOT NULL AND u.password_changed_at>=hold_row.held_at AND
    hold_row.credential_fingerprint<>encode(sha256(convert_to(u.password_hash,'UTF8')),'hex'),false) AS credential_changed
   FROM ertad.admin_users u LEFT JOIN ertad.web_account_security_holds hold_row ON hold_row.account_id=u.id AND hold_row.released_at IS NULL
   WHERE EXISTS(SELECT 1 FROM ertad.member_users m WHERE m.web_account_id=u.id)
    AND NOT EXISTS(SELECT 1 FROM ertad.platform_accounts p WHERE p.admin_user_id=u.id)
    AND (before_id IS NULL OR u.id<before_id)
    AND (input->>'accountId' IS NULL OR u.id=(input->>'accountId')::uuid)
    AND (filter_state='all' OR (filter_state='held' AND hold_row.id IS NOT NULL) OR (filter_state='available' AND hold_row.id IS NULL))
   ORDER BY u.id DESC LIMIT 26
  ), paged AS (SELECT * FROM selected ORDER BY id DESC LIMIT 25)
  SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'active',is_active,'createdAt',created_at,
   'recoverable',ertad.web_security_recoverable(id),
   'hold',CASE WHEN hold_id IS NULL THEN NULL ELSE jsonb_build_object('id',hold_id,'heldAt',held_at,'reason',reason,
    'own',actor_id=actor,'credentialChanged',credential_changed) END) ORDER BY id DESC) FROM paged),'[]'),
   'nextBefore',CASE WHEN (SELECT count(*) FROM selected)>25 THEN (SELECT id FROM paged ORDER BY id LIMIT 1) ELSE NULL END) INTO data;
  RETURN jsonb_build_object('data',data,'audit',audit);
 END IF;
 IF a.id IS NULL OR a.id=actor OR key IS NULL
 OR EXISTS(SELECT 1 FROM ertad.platform_accounts WHERE admin_user_id=a.id)
 OR NOT EXISTS(SELECT 1 FROM ertad.member_users WHERE web_account_id=a.id) THEN
  RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Account security action unavailable'; END IF;
 IF op='hold' THEN
  IF input->>'reason' IS NULL OR input->>'reason' NOT IN ('suspected_compromise','credential_exposure') THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid security reason'; END IF;
  SELECT * INTO h FROM ertad.web_account_security_holds WHERE actor_id=actor AND request_id=key;
  IF FOUND THEN
   IF h.account_id<>a.id OR h.reason IS DISTINCT FROM input->>'reason' THEN
    RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request key conflict'; END IF;
  ELSE
   IF NOT a.is_active OR ertad.web_account_held(a.id) OR NOT ertad.web_security_recoverable(a.id) THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Account unavailable'; END IF;
   stamp:=date_trunc('milliseconds',clock_timestamp());
   INSERT INTO ertad.web_account_security_holds(account_id,actor_id,request_id,reason,credential_fingerprint,held_at)
   VALUES(a.id,actor,key,input->>'reason',encode(sha256(convert_to(a.password_hash,'UTF8')),'hex'),stamp) RETURNING * INTO h;
   -- A real tuple write serializes stale REPEATABLE READ session creators too.
   UPDATE ertad.admin_users SET updated_at=stamp WHERE id=a.id;
   UPDATE ertad.admin_sessions SET revoked_at=COALESCE(revoked_at,stamp),step_up_expires_at=NULL WHERE admin_user_id=a.id;
   UPDATE ertad.web_account_recoveries SET revoked_at=COALESCE(revoked_at,stamp) WHERE account_id=a.id AND consumed_at IS NULL;
   UPDATE ertad.web_account_email_changes SET revoked_at=COALESCE(revoked_at,stamp) WHERE account_id=a.id AND confirmed_at IS NULL;
   UPDATE ertad.security_mail_jobs j SET token_cipher=NULL,state=CASE WHEN state IN ('queued','retry') THEN 'cancelled' ELSE state END,updated_at=stamp
    WHERE (state IN ('queued','retry') OR token_cipher IS NOT NULL) AND
     ((purpose='recovery' AND EXISTS(SELECT 1 FROM ertad.web_account_recoveries r WHERE r.id=j.source_id AND r.account_id=a.id AND r.consumed_at IS NULL))
      OR (purpose='email_change' AND EXISTS(SELECT 1 FROM ertad.web_account_email_changes e WHERE e.id=j.source_id AND e.account_id=a.id AND e.confirmed_at IS NULL)));
   changed:=true;
  END IF;
 ELSE
  SELECT * INTO h FROM ertad.web_account_security_holds WHERE id=(input->>'holdId')::uuid AND account_id=a.id FOR UPDATE;
  IF h.id IS NULL OR h.actor_id=actor THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Independent release required'; END IF;
  IF h.released_at IS NOT NULL THEN
   IF h.released_by<>actor OR h.release_request_id<>key THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Release changed'; END IF;
  ELSE
   IF NOT a.is_active OR a.password_changed_at IS NULL OR a.password_changed_at<h.held_at
    OR h.credential_fingerprint=encode(sha256(convert_to(a.password_hash,'UTF8')),'hex') THEN
    RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Credential recovery required'; END IF;
   UPDATE ertad.web_account_security_holds SET released_at=date_trunc('milliseconds',clock_timestamp()),released_by=actor,release_request_id=key
    WHERE id=h.id RETURNING * INTO h;
   UPDATE ertad.admin_users SET updated_at=clock_timestamp() WHERE id=a.id;
   changed:=true;
  END IF;
 END IF;
 RETURN jsonb_build_object('data',jsonb_build_object('id',h.id,'accountId',a.id,'heldAt',h.held_at,'releasedAt',h.released_at),
 'audit',CASE WHEN changed THEN audit||jsonb_build_object('holdId',h.id,'targetAccountId',a.id,'requestId',key) ELSE NULL END,
 'check',jsonb_build_object('id',h.id,'accountId',a.id,'actorId',h.actor_id,'heldAt',h.held_at,'reason',h.reason,
 'releasedAt',h.released_at,'releasedBy',h.released_by,'releaseRequestId',h.release_request_id,'fingerprint',h.credential_fingerprint,'changed',changed));
END $$;

DO $$ DECLARE body text; old text; BEGIN
 SELECT pg_get_functiondef('ertad.platform_session_command(uuid,text,text,jsonb)'::regprocedure) INTO body;old:=body;
 body:=replace(body,'SELECT s.id,s.created_at','SELECT s.id,s.admin_user_id,s.created_at');
 IF body=old THEN RAISE EXCEPTION 'Session reference projection changed'; END IF;old:=body;
 body:=replace(body,'''id'',id,''kind'',p.kind','''id'',id,''accountId'',CASE WHEN ''platform.accounts.read''=ANY(capabilities) AND p.kind=''organization'' THEN p.admin_user_id ELSE NULL END,''kind'',p.kind');
 IF body=old THEN RAISE EXCEPTION 'Session reference field changed'; END IF;EXECUTE body;
END $$;

CREATE FUNCTION ertad.web_account_security_finish(sid uuid,token text,op text,expected jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a ertad.admin_users; h ertad.web_account_security_holds; actor uuid;
BEGIN
 SELECT * INTO a FROM ertad.admin_users WHERE id=(expected->>'accountId')::uuid FOR UPDATE;
 actor:=ertad.web_security_actor(sid,token,op);
 SELECT * INTO h FROM ertad.web_account_security_holds WHERE id=(expected->>'id')::uuid;
 IF h.id IS NULL OR h.account_id IS DISTINCT FROM a.id OR h.actor_id IS DISTINCT FROM (expected->>'actorId')::uuid
 OR h.held_at IS DISTINCT FROM (expected->>'heldAt')::timestamptz OR h.reason IS DISTINCT FROM expected->>'reason'
 OR h.credential_fingerprint IS DISTINCT FROM expected->>'fingerprint'
 OR h.released_at IS DISTINCT FROM (expected->>'releasedAt')::timestamptz
 OR h.released_by IS DISTINCT FROM (expected->>'releasedBy')::uuid OR h.release_request_id IS DISTINCT FROM (expected->>'releaseRequestId')::uuid
 OR EXISTS(SELECT 1 FROM ertad.platform_accounts WHERE admin_user_id=a.id)
 OR NOT EXISTS(SELECT 1 FROM ertad.member_users WHERE web_account_id=a.id) THEN
  RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Security response changed during audit'; END IF;
 IF expected->>'changed'='true' THEN
  IF NOT a.is_active OR (op='hold' AND (h.released_at IS NOT NULL OR h.actor_id<>actor OR NOT ertad.web_security_recoverable(a.id)
   OR h.credential_fingerprint<>encode(sha256(convert_to(a.password_hash,'UTF8')),'hex')
   OR EXISTS(SELECT 1 FROM ertad.admin_sessions WHERE admin_user_id=a.id AND (revoked_at IS NULL OR step_up_expires_at IS NOT NULL))
   OR EXISTS(SELECT 1 FROM ertad.web_account_recoveries WHERE account_id=a.id AND consumed_at IS NULL AND revoked_at IS NULL)
   OR EXISTS(SELECT 1 FROM ertad.web_account_email_changes WHERE account_id=a.id AND confirmed_at IS NULL AND revoked_at IS NULL)
   OR EXISTS(SELECT 1 FROM ertad.security_mail_jobs j WHERE (j.state IN ('queued','retry') OR j.token_cipher IS NOT NULL) AND
    ((j.purpose='recovery' AND EXISTS(SELECT 1 FROM ertad.web_account_recoveries r WHERE r.id=j.source_id AND r.account_id=a.id AND r.consumed_at IS NULL))
    OR (j.purpose='email_change' AND EXISTS(SELECT 1 FROM ertad.web_account_email_changes e WHERE e.id=j.source_id AND e.account_id=a.id AND e.confirmed_at IS NULL))))))
   OR (op='release' AND (h.released_by IS DISTINCT FROM actor OR h.actor_id=actor
    OR a.password_changed_at IS NULL OR a.password_changed_at<h.held_at
    OR h.credential_fingerprint=encode(sha256(convert_to(a.password_hash,'UTF8')),'hex'))) THEN
   RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Security response failed final validation'; END IF;
 END IF;
END $$;
REVOKE ALL ON FUNCTION ertad.web_account_security_command(uuid,text,text,jsonb),ertad.web_account_security_finish(uuid,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.web_account_security_command(uuid,text,text,jsonb),ertad.web_account_security_finish(uuid,text,text,jsonb) TO ertad_app;

-- Only add sanitized technical events to the existing technical audit projection.
DO $$ DECLARE body text; old text; BEGIN
 SELECT pg_get_functiondef('ertad.platform_console_command(uuid,text,text,jsonb)'::regprocedure) INTO body;old:=body;
 body:=replace(body,'''PLATFORM_ACCESS_READ''','''PLATFORM_ACCOUNT_SECURITY_READ'',''PLATFORM_ACCOUNT_HELD'',''PLATFORM_ACCOUNT_RELEASED'',''PLATFORM_ACCOUNT_SECURITY_ENABLED'',''PLATFORM_ACCESS_READ''');
 IF body=old THEN RAISE EXCEPTION 'Technical audit extension changed'; END IF;EXECUTE body;
END $$;
