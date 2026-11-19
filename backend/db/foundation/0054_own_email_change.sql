-- Own verified-contact changes do not appoint, delegate or modify memberships.
CREATE TABLE ertad.web_account_email_changes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES ertad.admin_users(id),
 request_id uuid NOT NULL, organization_id uuid NOT NULL, contact_id uuid NOT NULL,
 old_email text NOT NULL, new_email text NOT NULL,
 credential_fingerprint text NOT NULL CHECK(credential_fingerprint ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
 token_hash text UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'), confirmed_at timestamptz, revoked_at timestamptz,
 FOREIGN KEY(organization_id,contact_id) REFERENCES ertad.web_invite_contacts(organization_id,id),
 UNIQUE(account_id,request_id),
 CHECK(old_email<>new_email AND old_email=lower(trim(old_email)) AND new_email=lower(trim(new_email))),
 CHECK(length(new_email)<=254 AND new_email ~ '^[a-z0-9._%+-]+@[a-z0-9.-]+[.][a-z]{2,}$'),
 CHECK(isfinite(expires_at) AND expires_at>created_at AND expires_at<=created_at+interval '30 minutes'),
 CHECK(confirmed_at IS NULL OR (token_hash IS NOT NULL AND revoked_at IS NULL))
);
CREATE UNIQUE INDEX web_email_pending ON ertad.web_account_email_changes(account_id) WHERE confirmed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX web_email_confirmed ON ertad.web_account_email_changes(account_id,confirmed_at DESC) WHERE confirmed_at IS NOT NULL;
REVOKE ALL ON ertad.web_account_email_changes FROM PUBLIC,ertad_app;

CREATE FUNCTION ertad.web_verified_email_contact(account uuid) RETURNS ertad.web_invite_contacts
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT c FROM ertad.admin_users a JOIN ertad.member_users m ON m.web_account_id=a.id
 JOIN ertad.web_invite_contacts c ON c.member_id=m.id
 JOIN ertad.web_invitations i ON (i.organization_id,i.contact_id)=(c.organization_id,c.id) AND i.account_id=a.id AND i.consumed_at IS NOT NULL
 LEFT JOIN LATERAL (SELECT * FROM ertad.web_account_email_changes ch WHERE ch.account_id=a.id AND ch.confirmed_at IS NOT NULL ORDER BY ch.confirmed_at DESC,ch.created_at DESC,ch.id DESC LIMIT 1) latest ON true
 WHERE a.id=account AND a.is_active AND (a.locked_until IS NULL OR a.locked_until<=clock_timestamp())
 AND m.status='active' AND c.source='email' AND c.verified_at IS NOT NULL AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp()
 AND EXISTS(SELECT 1 FROM ertad.organizations o WHERE o.id=c.organization_id AND o.status='active')
 AND a.email=COALESCE(latest.new_email,c.email)
 AND (latest.id IS NULL OR (latest.organization_id,latest.contact_id)=(c.organization_id,c.id))
 LIMIT 1
$$;
CREATE FUNCTION ertad.own_email_actor(sid uuid,token text,fresh boolean) RETURNS ertad.admin_users
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE s ertad.admin_sessions; a ertad.admin_users;
BEGIN
 SELECT * INTO s FROM ertad.admin_sessions WHERE id=sid AND token_hash=token FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 SELECT * INTO a FROM ertad.admin_users WHERE id=s.admin_user_id FOR UPDATE;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint);
 IF NOT a.is_active OR a.locked_until>clock_timestamp() OR s.revoked_at IS NOT NULL
 OR s.idle_expires_at<=clock_timestamp() OR s.absolute_expires_at<=clock_timestamp() THEN
 RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 IF fresh AND (s.step_up_expires_at IS NULL OR s.step_up_expires_at<=clock_timestamp()) THEN
 RAISE EXCEPTION USING ERRCODE='P0428',MESSAGE='Fresh authentication required'; END IF;
 RETURN a;
END $$;
CREATE FUNCTION ertad.web_email_live(e ertad.web_account_email_changes) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM ertad.admin_users a WHERE a.id=e.account_id AND e.revoked_at IS NULL AND e.confirmed_at IS NULL
 AND e.expires_at>clock_timestamp() AND a.email=e.old_email
 AND e.credential_fingerprint=encode(sha256(convert_to(a.password_hash,'UTF8')),'hex')
 AND ((ertad.web_verified_email_contact(a.id)).organization_id,(ertad.web_verified_email_contact(a.id)).id)=(e.organization_id,e.contact_id))
$$;
CREATE FUNCTION ertad.cancel_email_jobs(target uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 UPDATE ertad.security_mail_jobs SET state=CASE WHEN state IN ('queued','retry') THEN 'cancelled' ELSE state END,
 token_cipher=NULL,updated_at=clock_timestamp()
 WHERE purpose='email_change' AND source_id=target AND (state IN ('queued','retry') OR token_cipher IS NOT NULL);
END $$;

CREATE FUNCTION ertad.own_email_command(sid uuid,token text,op text,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a ertad.admin_users; c ertad.web_invite_contacts; e ertad.web_account_email_changes; old ertad.web_account_email_changes;
 policy jsonb; audit jsonb; stamp timestamptz; fresh_until timestamptz; changed boolean:=false;
BEGIN
 IF op IS NULL OR op NOT IN ('read','request','cancel','cancel_check','confirm') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid email operation'; END IF;
 a:=ertad.own_email_actor(sid,token,op<>'read'); c:=ertad.web_verified_email_contact(a.id); policy:=ertad.current_mail_policy();
 audit:=jsonb_build_object('adminUserId',a.id,'operation',op);
 IF op='read' THEN
 SELECT * INTO e FROM ertad.web_account_email_changes WHERE account_id=a.id AND confirmed_at IS NULL AND revoked_at IS NULL;
 RETURN jsonb_build_object('data',jsonb_build_object('accountId',a.id,'currentEmail',a.email,'available',c.id IS NOT NULL,
 'deliveryEnabled',policy->>'deliveryEnabled'='true' AND policy->>'mode'='enabled',
 'pending',CASE WHEN e.id IS NULL THEN NULL ELSE jsonb_build_object('id',e.id,'newEmail',e.new_email,'createdAt',e.created_at,'expiresAt',e.expires_at,
 'valid',ertad.web_email_live(e),'mailStatus',(SELECT state FROM ertad.security_mail_jobs WHERE purpose='email_change' AND source_id=e.id)) END),
 'audit',audit);
 END IF;
 IF op='request' THEN
 IF c.id IS NULL OR input->>'requestId' IS NULL OR input->>'newEmail' IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Email change unavailable'; END IF;
 SELECT * INTO e FROM ertad.web_account_email_changes WHERE account_id=a.id AND request_id=(input->>'requestId')::uuid;
 IF FOUND THEN
 IF e.new_email IS DISTINCT FROM input->>'newEmail' OR (e.confirmed_at IS NULL AND e.revoked_at IS NULL AND NOT ertad.web_email_live(e)) THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Email request changed'; END IF;
 RETURN jsonb_build_object('data',jsonb_build_object('id',e.id),'audit',NULL);
 END IF;
 IF policy->>'deliveryEnabled'<>'true' OR policy->>'mode'<>'enabled' OR input->>'newEmail'=a.email
 OR (SELECT count(*) FROM ertad.web_account_email_changes WHERE account_id=a.id AND created_at>clock_timestamp()-interval '1 hour')>=3 THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Email change unavailable'; END IF;
 FOR old IN SELECT * FROM ertad.web_account_email_changes WHERE account_id=a.id AND confirmed_at IS NULL AND revoked_at IS NULL AND NOT ertad.web_email_live(web_account_email_changes) FOR UPDATE LOOP
 UPDATE ertad.web_account_email_changes SET revoked_at=clock_timestamp() WHERE id=old.id; PERFORM ertad.cancel_email_jobs(old.id);
 END LOOP;
 IF EXISTS(SELECT 1 FROM ertad.web_account_email_changes WHERE account_id=a.id AND confirmed_at IS NULL AND revoked_at IS NULL) THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Pending email request exists'; END IF;
 stamp:=clock_timestamp();
 INSERT INTO ertad.web_account_email_changes(account_id,request_id,organization_id,contact_id,old_email,new_email,credential_fingerprint,created_at,expires_at)
 VALUES(a.id,(input->>'requestId')::uuid,c.organization_id,c.id,a.email,input->>'newEmail',encode(sha256(convert_to(a.password_hash,'UTF8')),'hex'),stamp,LEAST(stamp+interval '30 minutes',c.expires_at)) RETURNING * INTO e;
 RETURN jsonb_build_object('data',jsonb_build_object('id',e.id),'audit',audit||jsonb_build_object('requestId',e.id));
 END IF;
 SELECT * INTO e FROM ertad.web_account_email_changes WHERE id=(input->>'id')::uuid AND account_id=a.id FOR UPDATE;
 IF NOT FOUND OR e.confirmed_at IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Email request unavailable'; END IF;
 IF op IN ('cancel','cancel_check') THEN
 changed:=e.revoked_at IS NULL;
 IF op='cancel' THEN
 UPDATE ertad.web_account_email_changes SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=e.id;
 PERFORM ertad.cancel_email_jobs(e.id);
 ELSIF e.revoked_at IS NULL OR EXISTS(SELECT 1 FROM ertad.security_mail_jobs WHERE purpose='email_change' AND source_id=e.id AND (state IN ('queued','retry') OR token_cipher IS NOT NULL)) THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Email cancellation changed'; END IF;
 RETURN jsonb_build_object('data',jsonb_build_object('cancelled',true),'audit',CASE WHEN changed AND op='cancel' THEN audit||jsonb_build_object('requestId',e.id) ELSE NULL END);
 END IF;
 IF NOT ertad.web_email_live(e) OR input->>'digest' IS NULL OR e.token_hash IS DISTINCT FROM input->>'digest' OR e.new_email IS DISTINCT FROM input->>'newEmail'
 OR NOT EXISTS(SELECT 1 FROM ertad.security_mail_jobs WHERE purpose='email_change' AND source_id=e.id AND token_hash=e.token_hash AND state NOT IN ('failed','cancelled'))
 OR EXISTS(SELECT 1 FROM ertad.admin_users WHERE email=e.new_email AND id<>a.id) THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Email change unavailable'; END IF;
 SELECT step_up_expires_at INTO fresh_until FROM ertad.admin_sessions WHERE id=sid;
 stamp:=date_trunc('milliseconds',clock_timestamp());
 UPDATE ertad.web_account_email_changes SET confirmed_at=stamp WHERE id=e.id;
 UPDATE ertad.admin_users SET email=e.new_email,updated_at=stamp WHERE id=a.id;
 UPDATE ertad.admin_sessions SET revoked_at=COALESCE(revoked_at,stamp),step_up_expires_at=NULL WHERE admin_user_id=a.id;
 UPDATE ertad.web_account_recoveries SET revoked_at=COALESCE(revoked_at,stamp) WHERE account_id=a.id AND consumed_at IS NULL;
 UPDATE ertad.security_mail_jobs j SET token_cipher=NULL,state=CASE WHEN state IN ('queued','retry') THEN 'cancelled' ELSE state END,updated_at=stamp
 WHERE j.purpose='recovery' AND (j.state IN ('queued','retry') OR j.token_cipher IS NOT NULL)
 AND EXISTS(SELECT 1 FROM ertad.web_account_recoveries r WHERE r.id=j.source_id AND r.account_id=a.id AND r.consumed_at IS NULL);
 PERFORM ertad.cancel_email_jobs(e.id);
 RETURN jsonb_build_object('data',jsonb_build_object('changed',true),'audit',audit||jsonb_build_object('requestId',e.id),
 'check',jsonb_build_object('oldEmail',e.old_email,'newEmail',e.new_email,'fingerprint',e.credential_fingerprint,'contactId',e.contact_id,
 'organizationId',e.organization_id,'confirmedAt',stamp,'freshUntil',fresh_until));
END $$;

CREATE FUNCTION ertad.own_email_finish(sid uuid,token text,target uuid,digest text,expected jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s ertad.admin_sessions; a ertad.admin_users; e ertad.web_account_email_changes; c ertad.web_invite_contacts;
BEGIN
 SELECT * INTO s FROM ertad.admin_sessions WHERE id=sid AND token_hash=token;
 SELECT * INTO a FROM ertad.admin_users WHERE id=s.admin_user_id;
 SELECT * INTO e FROM ertad.web_account_email_changes WHERE id=target AND account_id=a.id;
 c:=ertad.web_verified_email_contact(a.id);
 IF e.id IS NULL OR NOT a.is_active OR a.locked_until>clock_timestamp() OR s.revoked_at IS NULL OR s.step_up_expires_at IS NOT NULL
 OR s.idle_expires_at<=clock_timestamp() OR s.absolute_expires_at<=clock_timestamp() OR (expected->>'freshUntil')::timestamptz<=clock_timestamp()
 OR e.revoked_at IS NOT NULL OR e.confirmed_at IS NULL OR e.expires_at<=clock_timestamp() OR e.token_hash IS DISTINCT FROM digest
 OR e.old_email IS DISTINCT FROM expected->>'oldEmail' OR e.new_email IS DISTINCT FROM expected->>'newEmail' OR a.email IS DISTINCT FROM e.new_email
 OR e.credential_fingerprint IS DISTINCT FROM expected->>'fingerprint' OR e.credential_fingerprint<>encode(sha256(convert_to(a.password_hash,'UTF8')),'hex')
 OR (e.contact_id,e.organization_id) IS DISTINCT FROM ((expected->>'contactId')::uuid,(expected->>'organizationId')::uuid)
 OR e.confirmed_at IS DISTINCT FROM (expected->>'confirmedAt')::timestamptz OR c.id IS DISTINCT FROM e.contact_id OR c.organization_id IS DISTINCT FROM e.organization_id
 OR EXISTS(SELECT 1 FROM ertad.admin_sessions WHERE admin_user_id=a.id AND (revoked_at IS NULL OR step_up_expires_at IS NOT NULL))
 OR EXISTS(SELECT 1 FROM ertad.web_account_recoveries WHERE account_id=a.id AND consumed_at IS NULL AND revoked_at IS NULL)
 OR NOT EXISTS(SELECT 1 FROM ertad.security_mail_jobs WHERE id=(expected->>'noticeId')::uuid AND purpose='email_changed' AND source_id=e.id AND state='queued' AND token_cipher IS NOT NULL AND token_hash=expected->>'noticeDigest') THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Email change failed final validation'; END IF;
END $$;
REVOKE ALL ON FUNCTION ertad.web_verified_email_contact(uuid),ertad.own_email_actor(uuid,text,boolean),ertad.web_email_live(ertad.web_account_email_changes),ertad.cancel_email_jobs(uuid) FROM PUBLIC,ertad_app;
REVOKE ALL ON FUNCTION ertad.own_email_command(uuid,text,text,jsonb),ertad.own_email_finish(uuid,text,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.own_email_command(uuid,text,text,jsonb),ertad.own_email_finish(uuid,text,uuid,text,jsonb) TO ertad_app;

-- Recover to the account's latest proven address while preserving its original member binding.
DO $$ DECLARE body text; old text; BEGIN
 SELECT pg_get_functiondef('ertad.web_recovery_eligible(uuid,uuid,uuid)'::regprocedure) INTO body; old:=body;
 body:=replace(body,'c.member_id=m.id AND c.email=a.email','c.member_id=m.id');
 IF body=old THEN RAISE EXCEPTION 'Recovery join extension changed'; END IF;old:=body;
 body:=replace(body,'(c.source=''synthetic'' OR (c.source=''email'' AND c.verified_at IS NOT NULL))','((c.source=''synthetic'' AND c.email=a.email) OR (c.source=''email'' AND ((ertad.web_verified_email_contact(a.id)).organization_id,(ertad.web_verified_email_contact(a.id)).id)=(c.organization_id,c.id)))');
 IF body=old THEN RAISE EXCEPTION 'Recovery contact extension changed'; END IF; EXECUTE body;
 SELECT pg_get_functiondef('ertad.web_recovery_request(text)'::regprocedure) INTO body; old:=body;
 body:=replace(body,'contact.email=a.email AND ertad.web_recovery_eligible','ertad.web_recovery_eligible');
 IF body=old THEN RAISE EXCEPTION 'Recovery request extension changed'; END IF; EXECUTE body;
 SELECT pg_get_functiondef('ertad.own_web_recovery(uuid,text,text,uuid)'::regprocedure) INTO body; old:=body;
 body:=replace(body,'WHERE c.email=a.email','WHERE true');
 IF body=old THEN RAISE EXCEPTION 'Own recovery extension changed'; END IF; EXECUTE body;
END $$;

ALTER TABLE ertad.security_mail_jobs DROP CONSTRAINT security_mail_jobs_purpose_check;
ALTER TABLE ertad.security_mail_jobs ADD CHECK(purpose IN ('contact','invitation','recovery','email_change','email_changed'));
ALTER FUNCTION ertad.security_mail_source(text,uuid) RENAME TO security_mail_source_before_email;
CREATE FUNCTION ertad.security_mail_source(kind text,source uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE e ertad.web_account_email_changes; a ertad.admin_users; data jsonb;
BEGIN
 IF kind NOT IN ('email_change','email_changed') THEN
 data:=ertad.security_mail_source_before_email(kind,source);
 IF kind='recovery' THEN RETURN data||jsonb_build_object('email',(SELECT account_row.email FROM ertad.admin_users account_row JOIN ertad.web_account_recoveries r ON r.account_id=account_row.id WHERE r.id=source)); END IF;
 RETURN data;
 END IF;
 SELECT account_id INTO e.account_id FROM ertad.web_account_email_changes WHERE id=source;
 SELECT * INTO a FROM ertad.admin_users WHERE id=e.account_id FOR UPDATE;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint);
 SELECT * INTO e FROM ertad.web_account_email_changes WHERE id=source FOR UPDATE;
 IF e.id IS NULL OR (kind='email_change' AND NOT ertad.web_email_live(e))
 OR (kind='email_changed' AND (e.confirmed_at IS NULL OR e.revoked_at IS NOT NULL OR e.confirmed_at+interval '24 hours'<=clock_timestamp())) THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Email source unavailable'; END IF;
 RETURN jsonb_build_object('email',CASE WHEN kind='email_changed' THEN e.old_email ELSE e.new_email END,
 'expiresAt',CASE WHEN kind='email_changed' THEN e.confirmed_at+interval '24 hours' ELSE e.expires_at END,'hash',e.token_hash);
END $$;
ALTER FUNCTION ertad.security_mail_candidates() RENAME TO security_mail_candidates_before_email;
CREATE FUNCTION ertad.security_mail_candidates() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE(jsonb_agg(item),'[]') FROM (
 SELECT value item FROM jsonb_array_elements(ertad.security_mail_candidates_before_email())
 UNION ALL
 SELECT jsonb_build_object('purpose',CASE WHEN e.confirmed_at IS NULL THEN 'email_change' ELSE 'email_changed' END,'id',e.id)
 FROM ertad.web_account_email_changes e WHERE e.revoked_at IS NULL
 AND ((e.confirmed_at IS NULL AND e.token_hash IS NULL AND ertad.web_email_live(e)) OR (e.confirmed_at IS NOT NULL AND e.confirmed_at+interval '24 hours'>clock_timestamp()))
 AND NOT EXISTS(SELECT 1 FROM ertad.security_mail_jobs j WHERE j.source_id=e.id AND j.purpose=CASE WHEN e.confirmed_at IS NULL THEN 'email_change' ELSE 'email_changed' END)
 LIMIT 20) jobs
$$;
ALTER FUNCTION ertad.security_mail_prepare(text,uuid,text,text) RENAME TO security_mail_prepare_before_email;
CREATE FUNCTION ertad.security_mail_prepare(kind text,source uuid,digest text,cipher text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE data jsonb; policy jsonb; job uuid;
BEGIN
 IF kind NOT IN ('email_change','email_changed') THEN RETURN ertad.security_mail_prepare_before_email(kind,source,digest,cipher); END IF;
 data:=ertad.security_mail_source(kind,source);policy:=ertad.current_mail_policy();
 SELECT id INTO job FROM ertad.security_mail_jobs WHERE purpose=kind AND source_id=source;
 IF FOUND THEN RETURN job; END IF;
 IF kind='email_change' AND (policy->>'deliveryEnabled'<>'true' OR policy->>'mode'<>'enabled') THEN RETURN NULL; END IF;
 IF digest IS NULL OR digest !~ '^[a-f0-9]{64}$' OR cipher IS NULL OR cipher NOT LIKE 'v2:%' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Delivery nonce required'; END IF;
 IF kind='email_change' THEN
 UPDATE ertad.web_account_email_changes SET token_hash=digest WHERE id=source AND token_hash IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Email token already issued'; END IF;
 END IF;
 INSERT INTO ertad.security_mail_jobs(purpose,source_id,token_hash,token_cipher,policy_version,expires_at)
 VALUES(kind,source,digest,cipher,(policy->>'version')::integer,(data->>'expiresAt')::timestamptz) RETURNING id INTO job;
 RETURN job;
END $$;
REVOKE ALL ON FUNCTION ertad.security_mail_source_before_email(text,uuid),ertad.security_mail_candidates_before_email(),ertad.security_mail_prepare_before_email(text,uuid,text,text),ertad.security_mail_source(text,uuid) FROM PUBLIC,ertad_app;
REVOKE ALL ON FUNCTION ertad.security_mail_candidates(),ertad.security_mail_prepare(text,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.security_mail_candidates(),ertad.security_mail_prepare(text,uuid,text,text) TO ertad_app;
