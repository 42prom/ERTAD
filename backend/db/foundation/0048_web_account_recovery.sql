-- Personal recovery uses a previously activated immutable synthetic contact.
-- It never restores an account, MFA, membership or technical authority.
CREATE TABLE ertad.web_account_recoveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES ertad.admin_users(id),
 organization_id uuid NOT NULL, contact_id uuid NOT NULL,
 credential_fingerprint text NOT NULL CHECK(credential_fingerprint ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
 token_hash text UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'), delivered_at timestamptz,
 consumed_at timestamptz, revoked_at timestamptz,
 FOREIGN KEY(organization_id,contact_id) REFERENCES ertad.web_invite_contacts(organization_id,id),
 CHECK(isfinite(expires_at) AND expires_at>created_at AND expires_at<=created_at+interval '30 minutes'),
 CHECK((token_hash IS NULL)=(delivered_at IS NULL)),
 CHECK(consumed_at IS NULL OR delivered_at IS NOT NULL)
);
CREATE INDEX web_recovery_account ON ertad.web_account_recoveries(account_id,created_at DESC);
CREATE INDEX web_invite_contact_email ON ertad.web_invite_contacts(email);
CREATE UNIQUE INDEX web_recovery_pending ON ertad.web_account_recoveries(account_id)
 WHERE consumed_at IS NULL AND revoked_at IS NULL;
REVOKE ALL ON ertad.web_account_recoveries FROM PUBLIC,ertad_app;

CREATE FUNCTION ertad.web_recovery_eligible(account uuid,org uuid,contact uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM ertad.admin_users a
 JOIN ertad.member_users m ON m.web_account_id=a.id
 JOIN ertad.web_invite_contacts c ON c.member_id=m.id AND c.email=a.email
 WHERE a.id=account AND c.organization_id=org AND c.id=contact AND a.is_active
 AND (a.locked_until IS NULL OR a.locked_until<=clock_timestamp())
 AND NOT a.mfa_enabled AND a.mfa_secret_encrypted IS NULL AND m.status='active'
 AND c.source='synthetic' AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp()
 AND EXISTS(SELECT 1 FROM ertad.organizations o WHERE o.id=org AND o.status='active')
 AND NOT EXISTS(SELECT 1 FROM ertad.platform_accounts p WHERE p.admin_user_id=account)
 AND EXISTS(SELECT 1 FROM ertad.web_invitations i WHERE i.organization_id=org AND i.contact_id=contact
 AND i.account_id=account AND i.consumed_at IS NOT NULL))
$$;

CREATE FUNCTION ertad.web_recovery_request(address text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a ertad.admin_users; c ertad.web_invite_contacts; r ertad.web_account_recoveries; stamp timestamptz;
BEGIN
 IF address IS NULL OR length(address)>254 THEN RETURN NULL; END IF;
 SELECT * INTO a FROM ertad.admin_users WHERE email=lower(trim(address)) FOR UPDATE;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint);
 IF a.id IS NULL THEN RETURN NULL; END IF;
 SELECT contact.* INTO c FROM ertad.web_invite_contacts contact
 WHERE contact.email=a.email AND ertad.web_recovery_eligible(a.id,contact.organization_id,contact.id)
 ORDER BY contact.expires_at DESC,contact.id LIMIT 1;
 IF c.id IS NULL THEN RETURN NULL; END IF;
 stamp:=clock_timestamp();
 UPDATE ertad.web_account_recoveries SET revoked_at=stamp WHERE account_id=a.id AND consumed_at IS NULL AND revoked_at IS NULL
 AND (expires_at<=stamp OR credential_fingerprint<>encode(sha256(convert_to(a.password_hash,'UTF8')),'hex')
 OR NOT ertad.web_recovery_eligible(a.id,organization_id,contact_id));
 SELECT * INTO r FROM ertad.web_account_recoveries WHERE account_id=a.id AND consumed_at IS NULL AND revoked_at IS NULL;
 IF r.id IS NOT NULL THEN RETURN r.id; END IF;
 INSERT INTO ertad.web_account_recoveries(account_id,organization_id,contact_id,credential_fingerprint,created_at,expires_at)
 VALUES(a.id,c.organization_id,c.id,encode(sha256(convert_to(a.password_hash,'UTF8')),'hex'),stamp,LEAST(stamp+interval '30 minutes',c.expires_at)) RETURNING id INTO r.id;
 RETURN r.id;
END $$;

CREATE FUNCTION ertad.web_recovery_live(recovery uuid,expected_hash text DEFAULT NULL) RETURNS ertad.web_account_recoveries
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r ertad.web_account_recoveries; a ertad.admin_users;
BEGIN
 SELECT * INTO r FROM ertad.web_account_recoveries WHERE id=recovery;
 SELECT * INTO a FROM ertad.admin_users WHERE id=r.account_id FOR UPDATE;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint);
 SELECT * INTO r FROM ertad.web_account_recoveries WHERE id=recovery FOR UPDATE;
 IF r.id IS NULL OR r.revoked_at IS NOT NULL OR r.expires_at<=clock_timestamp()
 OR NOT ertad.web_recovery_eligible(r.account_id,r.organization_id,r.contact_id)
 OR (expected_hash IS NULL AND (r.consumed_at IS NOT NULL OR r.credential_fingerprint<>encode(sha256(convert_to(a.password_hash,'UTF8')),'hex')))
 OR (expected_hash IS NOT NULL AND (r.consumed_at IS NULL OR a.password_hash IS DISTINCT FROM expected_hash)) THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Recovery unavailable'; END IF;
 RETURN r;
END $$;
CREATE FUNCTION ertad.web_recovery_request_finish(recovery uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF recovery IS NOT NULL THEN PERFORM ertad.web_recovery_live(recovery); END IF;
END $$;

-- Only the local database owner can prepare delivery, never the public API.
CREATE FUNCTION ertad.web_recovery_delivery(recovery uuid,digest text) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r ertad.web_account_recoveries;
BEGIN
 r:=ertad.web_recovery_live(recovery);
 IF r.token_hash IS NOT NULL OR digest IS NULL OR digest !~ '^[0-9a-f]{64}$' THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Recovery delivery unavailable'; END IF;
 UPDATE ertad.web_account_recoveries SET token_hash=digest,delivered_at=clock_timestamp() WHERE id=r.id;
 RETURN jsonb_build_object('id',r.id,'email',(SELECT email FROM ertad.admin_users WHERE id=r.account_id));
END $$;

CREATE FUNCTION ertad.web_recovery_consume(recovery uuid,digest text,next_hash text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r ertad.web_account_recoveries; a ertad.admin_users; stamp timestamptz;
BEGIN
 r:=ertad.web_recovery_live(recovery);
 IF digest IS NULL OR r.token_hash IS DISTINCT FROM digest OR r.delivered_at IS NULL THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Recovery unavailable'; END IF;
 SELECT * INTO a FROM ertad.admin_users WHERE id=r.account_id;
 IF next_hash IS NULL THEN RETURN jsonb_build_object('email',a.email,'passwordHash',a.password_hash); END IF;
 IF next_hash=a.password_hash OR next_hash !~ '^\$2[aby]\$1[0-4]\$[./A-Za-z0-9]{53}$' THEN
 RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='New password hash required'; END IF;
 stamp:=date_trunc('milliseconds',clock_timestamp());
 UPDATE ertad.admin_users SET password_hash=next_hash,password_changed_at=stamp,updated_at=stamp WHERE id=r.account_id;
 UPDATE ertad.admin_sessions SET revoked_at=COALESCE(revoked_at,stamp),step_up_expires_at=NULL WHERE admin_user_id=r.account_id;
 UPDATE ertad.web_account_recoveries SET consumed_at=stamp WHERE id=r.id;
 UPDATE ertad.web_account_recoveries SET revoked_at=COALESCE(revoked_at,stamp)
 WHERE account_id=r.account_id AND id<>r.id AND consumed_at IS NULL;
 RETURN jsonb_build_object('accountId',r.account_id);
END $$;
CREATE FUNCTION ertad.web_recovery_finish(recovery uuid,digest text,next_hash text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r ertad.web_account_recoveries;
BEGIN
 IF next_hash IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='New password required'; END IF;
 r:=ertad.web_recovery_live(recovery,next_hash);
 IF digest IS NULL OR r.token_hash IS DISTINCT FROM digest OR r.delivered_at IS NULL
 OR EXISTS(SELECT 1 FROM ertad.admin_sessions WHERE admin_user_id=r.account_id AND (revoked_at IS NULL OR step_up_expires_at IS NOT NULL)) THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Recovery changed during audit'; END IF;
END $$;
REVOKE ALL ON FUNCTION ertad.web_recovery_eligible(uuid,uuid,uuid),ertad.web_recovery_live(uuid,text),ertad.web_recovery_delivery(uuid,text) FROM PUBLIC,ertad_app;
REVOKE ALL ON FUNCTION ertad.web_recovery_request(text),ertad.web_recovery_request_finish(uuid),ertad.web_recovery_consume(uuid,text,text),ertad.web_recovery_finish(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.web_recovery_request(text),ertad.web_recovery_request_finish(uuid),ertad.web_recovery_consume(uuid,text,text),ertad.web_recovery_finish(uuid,text,text) TO ertad_app;
