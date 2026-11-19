-- Governed lost-contact/MFA recovery and account-wide disable/restore.
-- Technical governance stays strictly separated from organizational membership and authority.
ALTER TABLE ertad.platform_accounts DROP CONSTRAINT platform_accounts_permissions_check;
ALTER TABLE ertad.platform_accounts ADD CONSTRAINT platform_accounts_permissions_check CHECK (
  permissions <@ ARRAY[
    'platform.read','platform.audit.read','platform.sessions.read','platform.sessions.revoke',
    'platform.integrations.read','platform.integrations.test','platform.policy.read','platform.policy.propose','platform.policy.approve',
    'platform.network.read','platform.network.propose','platform.network.approve','platform.limits.read','platform.limits.propose','platform.limits.approve',
    'platform.providers.read','platform.providers.propose','platform.providers.approve',
    'platform.accounts.read','platform.accounts.hold','platform.accounts.release','platform.accounts.propose','platform.accounts.approve'
  ]::text[] AND array_position(permissions,NULL) IS NULL
);

CREATE TABLE ertad.web_account_lifecycle_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES ertad.admin_users(id),
  action text NOT NULL CHECK(action IN ('disable_account','restore_account','lost_contact_recovery','mfa_reset')),
  proposer_id uuid NOT NULL REFERENCES ertad.platform_accounts(admin_user_id),
  request_id uuid NOT NULL,
  reason text NOT NULL CHECK(reason IN ('policy_violation','departure','account_restoration','lost_contact','lost_mfa_device','mfa_compromise')),
  new_email text CHECK(new_email IS NULL OR (new_email = lower(trim(new_email)) AND length(new_email) <= 254 AND new_email ~ '^[a-z0-9._%+-]+@[a-z0-9.-]+[.][a-z]{2,}$')),
  expected_active boolean NOT NULL,
  expected_mfa_enabled boolean NOT NULL,
  expected_mfa_provisioned boolean NOT NULL,
  expected_email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '24 hours',
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','withdrawn','expired')),
  reviewer_id uuid REFERENCES ertad.platform_accounts(admin_user_id),
  review_request_id uuid,
  reviewed_at timestamptz,
  UNIQUE(proposer_id, request_id),
  UNIQUE(reviewer_id, review_request_id),
  CHECK(proposer_id <> account_id),
  CHECK((action = 'lost_contact_recovery') = (new_email IS NOT NULL)),
  CHECK(new_email IS NULL OR new_email <> expected_email),
  CHECK(
    (action = 'disable_account' AND reason IN ('policy_violation','departure'))
    OR (action = 'restore_account' AND reason = 'account_restoration')
    OR (action = 'lost_contact_recovery' AND reason = 'lost_contact')
    OR (action = 'mfa_reset' AND reason IN ('lost_mfa_device','mfa_compromise'))
  ),
  CHECK(
    (status IN ('pending','expired') AND reviewer_id IS NULL AND review_request_id IS NULL AND reviewed_at IS NULL)
    OR (status IN ('approved','rejected','withdrawn') AND reviewer_id IS NOT NULL AND review_request_id IS NOT NULL AND reviewed_at IS NOT NULL)
  ),
  CHECK(status NOT IN ('approved','rejected') OR (reviewer_id <> proposer_id AND reviewer_id <> account_id)),
  CHECK(status <> 'withdrawn' OR reviewer_id = proposer_id)
);
CREATE UNIQUE INDEX web_lifecycle_pending ON ertad.web_account_lifecycle_proposals(account_id, action) WHERE status = 'pending';
CREATE INDEX web_lifecycle_account_history ON ertad.web_account_lifecycle_proposals(created_at DESC, id DESC);
CREATE INDEX web_lifecycle_lost_contact ON ertad.web_account_lifecycle_proposals(account_id, reviewed_at DESC, id DESC) WHERE action = 'lost_contact_recovery' AND status = 'approved';
REVOKE ALL ON ertad.web_account_lifecycle_proposals FROM PUBLIC, ertad_app;

-- Never expose raw emails in technical projections; return only a bounded masked hint when applicable.
CREATE FUNCTION ertad.mask_email_hint(address text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN address IS NULL OR position('@' IN address) < 2 THEN NULL ELSE
    left(split_part(address,'@',1), LEAST(2, GREATEST(1, length(split_part(address,'@',1)) - 1)))
    || '…@' || split_part(address,'@',2)
  END
$$;

CREATE FUNCTION ertad.web_lost_contact_eligible(account uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT EXISTS(
    SELECT 1 FROM ertad.admin_users a
    JOIN ertad.member_users m ON m.web_account_id=a.id
    WHERE a.id=account AND a.is_active AND m.status='active'
    AND NOT EXISTS(SELECT 1 FROM ertad.platform_accounts p WHERE p.admin_user_id=a.id)
    AND EXISTS(
      SELECT 1 FROM ertad.web_invitations i
      JOIN ertad.web_invite_contacts c ON (c.organization_id,c.id)=(i.organization_id,i.contact_id)
      JOIN ertad.organizations o ON o.id=c.organization_id
      WHERE i.account_id=a.id AND i.consumed_at IS NOT NULL AND c.revoked_at IS NULL
      AND c.expires_at>clock_timestamp() AND o.status='active'
    )
  )
$$;

-- Resolve whichever email replacement occurred most recently: self-service confirmed change or governed lost-contact approval.
CREATE FUNCTION ertad.web_effective_email_update(account uuid)
RETURNS TABLE(new_email text, organization_id uuid, contact_id uuid, is_lost_contact boolean)
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT u.new_email, u.organization_id, u.contact_id, u.is_lost_contact
  FROM (
    SELECT ch.new_email, ch.organization_id, ch.contact_id, false AS is_lost_contact, ch.confirmed_at AS ts, ch.id
    FROM ertad.web_account_email_changes ch
    WHERE ch.account_id=account AND ch.confirmed_at IS NOT NULL
    UNION ALL
    SELECT lp.new_email, NULL::uuid AS organization_id, NULL::uuid AS contact_id, true AS is_lost_contact, lp.reviewed_at AS ts, lp.id
    FROM ertad.web_account_lifecycle_proposals lp
    WHERE lp.account_id=account AND lp.action='lost_contact_recovery' AND lp.status='approved'
  ) u
  ORDER BY u.ts DESC, u.id DESC
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION ertad.web_verified_email_contact(account uuid) RETURNS ertad.web_invite_contacts
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT c FROM ertad.admin_users a
  JOIN ertad.member_users m ON m.web_account_id=a.id
  JOIN ertad.web_invite_contacts c ON c.member_id=m.id
  JOIN ertad.web_invitations i ON (i.organization_id,i.contact_id)=(c.organization_id,c.id) AND i.account_id=a.id AND i.consumed_at IS NOT NULL
  LEFT JOIN LATERAL ertad.web_effective_email_update(a.id) latest ON true
  WHERE a.id=account AND a.is_active AND (a.locked_until IS NULL OR a.locked_until<=clock_timestamp())
  AND m.status='active' AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp()
  AND EXISTS(SELECT 1 FROM ertad.organizations o WHERE o.id=c.organization_id AND o.status='active')
  AND a.email=COALESCE(latest.new_email,c.email)
  AND (
    (COALESCE(latest.is_lost_contact,false)=true AND a.email !~ '@example[.]invalid$')
    OR (COALESCE(latest.is_lost_contact,false)=false AND c.source='email' AND c.verified_at IS NOT NULL
        AND (latest.new_email IS NULL OR (latest.organization_id,latest.contact_id)=(c.organization_id,c.id)))
  )
  ORDER BY c.expires_at DESC, c.id DESC
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION ertad.web_recovery_eligible(account uuid, org uuid, contact uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT EXISTS(
    SELECT 1 FROM ertad.admin_users a
    JOIN ertad.member_users m ON m.web_account_id=a.id
    JOIN ertad.web_invite_contacts c ON c.member_id=m.id
    LEFT JOIN LATERAL ertad.web_effective_email_update(a.id) latest ON true
    WHERE a.id=account AND c.organization_id=org AND c.id=contact AND a.is_active
    AND (a.locked_until IS NULL OR a.locked_until<=clock_timestamp())
    AND NOT a.mfa_enabled AND a.mfa_secret_encrypted IS NULL AND m.status='active'
    AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp()
    AND EXISTS(SELECT 1 FROM ertad.organizations o WHERE o.id=org AND o.status='active')
    AND NOT EXISTS(SELECT 1 FROM ertad.platform_accounts p WHERE p.admin_user_id=account)
    AND EXISTS(SELECT 1 FROM ertad.web_invitations i WHERE i.organization_id=org AND i.contact_id=contact
      AND i.account_id=account AND i.consumed_at IS NOT NULL)
    AND a.email=COALESCE(latest.new_email,c.email)
    AND (
      (a.email ~ '@example[.]invalid$' AND (c.source='synthetic' OR COALESCE(latest.is_lost_contact,false)=true))
      OR (a.email !~ '@example[.]invalid$' AND ((ertad.web_verified_email_contact(a.id)).organization_id,(ertad.web_verified_email_contact(a.id)).id)=(c.organization_id,c.id))
    )
  )
$$;

DO $$ DECLARE body text; old text; BEGIN
  SELECT pg_get_functiondef('ertad.security_mail_source_before_email(text,uuid)'::regprocedure) INTO body; old:=body;
  body:=replace(
    body,
    'IF c.source<>''email'' OR c.verified_at IS NULL THEN RAISE EXCEPTION USING ERRCODE=''P0409'',MESSAGE=''Contact proof required''; END IF;',
    'IF NOT EXISTS(SELECT 1 FROM ertad.admin_users acct WHERE acct.id=r.account_id AND acct.email !~ ''@example[.]invalid$'' AND ((ertad.web_verified_email_contact(acct.id)).organization_id,(ertad.web_verified_email_contact(acct.id)).id)=(r.organization_id,r.contact_id)) THEN RAISE EXCEPTION USING ERRCODE=''P0409'',MESSAGE=''Contact proof required''; END IF;'
  );
  IF body=old THEN RAISE EXCEPTION 'Security mail source recovery check changed'; END IF;
  EXECUTE body;

  SELECT pg_get_functiondef('ertad.security_mail_candidates_before_email()'::regprocedure) INTO body; old:=body;
  body:=replace(
    body,
    'FROM ertad.web_account_recoveries r JOIN ertad.web_invite_contacts c ON (c.organization_id,c.id)=(r.organization_id,r.contact_id)'||chr(10)||' WHERE c.source=''email''',
    'FROM ertad.web_account_recoveries r JOIN ertad.web_invite_contacts c ON (c.organization_id,c.id)=(r.organization_id,r.contact_id) JOIN ertad.admin_users acct ON acct.id=r.account_id'||chr(10)||' WHERE acct.email !~ ''@example[.]invalid$'''
  );
  IF body=old THEN
    body:=replace(
      body,
      'WHERE c.source=''email'' AND r.token_hash IS NULL',
      'WHERE EXISTS(SELECT 1 FROM ertad.admin_users acct WHERE acct.id=r.account_id AND acct.email !~ ''@example[.]invalid$'') AND r.token_hash IS NULL'
    );
  END IF;
  IF body=old THEN RAISE EXCEPTION 'Security mail candidates recovery check changed'; END IF;
  EXECUTE body;
END $$;

-- Block unrevoked session creation or revival on disabled accounts as well as held accounts.
CREATE OR REPLACE FUNCTION ertad.guard_held_web_session() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE active_flag boolean;
BEGIN
  IF NEW.revoked_at IS NULL THEN
    SELECT is_active INTO active_flag FROM ertad.admin_users WHERE id=NEW.admin_user_id FOR SHARE;
    IF NOT COALESCE(active_flag,false) OR ertad.web_account_held(NEW.admin_user_id) THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Session unavailable';
    END IF;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION ertad.mask_email_hint(text), ertad.web_lost_contact_eligible(uuid), ertad.web_effective_email_update(uuid) FROM PUBLIC, ertad_app;

-- Extend account list projection cleanly while keeping existing hold/release contract intact.
CREATE OR REPLACE FUNCTION ertad.web_account_security_command(sid uuid, token text, op text, input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid; a ertad.admin_users; h ertad.web_account_security_holds; target uuid;
  key uuid:=(input->>'requestId')::uuid; before_id uuid:=(input->>'before')::uuid;
  filter_state text:=COALESCE(input->>'state','all'); audit jsonb; data jsonb; changed boolean:=false; stamp timestamptz;
BEGIN
  IF op IS NULL OR op NOT IN ('list','hold','release') OR filter_state NOT IN ('all','held','available','disabled','pending_review') THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid account security operation';
  END IF;
  IF op<>'list' THEN
    target:=CASE WHEN op='hold' THEN (input->>'accountId')::uuid ELSE
      (SELECT account_id FROM ertad.web_account_security_holds WHERE id=(input->>'holdId')::uuid) END;
    SELECT * INTO a FROM ertad.admin_users WHERE id=target FOR UPDATE;
  END IF;
  actor:=ertad.web_security_actor(sid,token,op);
  audit:=jsonb_build_object('adminUserId',actor,'operation',op);
  IF op='list' THEN
    WITH selected AS (
      SELECT u.id,u.is_active,u.created_at,u.mfa_enabled,u.mfa_secret_encrypted IS NOT NULL AS mfa_provisioned,
        hold_row.id hold_id,hold_row.actor_id,hold_row.held_at,hold_row.reason,
        COALESCE(hold_row.id IS NOT NULL AND u.password_changed_at>=hold_row.held_at AND
          hold_row.credential_fingerprint<>encode(sha256(convert_to(u.password_hash,'UTF8')),'hex'),false) AS credential_changed
      FROM ertad.admin_users u
      LEFT JOIN ertad.web_account_security_holds hold_row ON hold_row.account_id=u.id AND hold_row.released_at IS NULL
      WHERE EXISTS(SELECT 1 FROM ertad.member_users m WHERE m.web_account_id=u.id)
        AND NOT EXISTS(SELECT 1 FROM ertad.platform_accounts p WHERE p.admin_user_id=u.id)
        AND (before_id IS NULL OR u.id<before_id)
        AND (input->>'accountId' IS NULL OR u.id=(input->>'accountId')::uuid)
        AND (
          filter_state='all'
          OR (filter_state='held' AND hold_row.id IS NOT NULL)
          OR (filter_state='available' AND hold_row.id IS NULL AND u.is_active)
          OR (filter_state='disabled' AND NOT u.is_active)
          OR (filter_state='pending_review' AND EXISTS(SELECT 1 FROM ertad.web_account_lifecycle_proposals lp WHERE lp.account_id=u.id AND lp.status='pending' AND lp.expires_at>clock_timestamp()))
        )
      ORDER BY u.id DESC LIMIT 26
    ), paged AS (SELECT * FROM selected ORDER BY id DESC LIMIT 25)
    SELECT jsonb_build_object(
      'items',COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id',id,'active',is_active,'recoverable',ertad.web_security_recoverable(id),'createdAt',created_at,
        'mfaEnabled',mfa_enabled,'mfaProvisioned',mfa_provisioned,
        'lostContactEligible',ertad.web_lost_contact_eligible(id),
        'hold',CASE WHEN hold_id IS NULL THEN NULL ELSE jsonb_build_object('id',hold_id,'heldAt',held_at,'reason',reason,
          'own',actor_id=actor,'credentialChanged',credential_changed) END,
        'pendingProposals',COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id',lp.id,'action',lp.action,'reason',lp.reason,'createdAt',lp.created_at,'expiresAt',lp.expires_at,
            'mine',lp.proposer_id=actor,'newEmailHint',ertad.mask_email_hint(lp.new_email)
          ) ORDER BY lp.created_at DESC, lp.id DESC)
          FROM ertad.web_account_lifecycle_proposals lp
          WHERE lp.account_id=paged.id AND lp.status='pending' AND lp.expires_at>clock_timestamp()
        ),'[]'::jsonb)
      ) ORDER BY id DESC) FROM paged),'[]'),
      'nextBefore',CASE WHEN (SELECT count(*) FROM selected)>25 THEN (SELECT id FROM paged ORDER BY id LIMIT 1) ELSE NULL END,
      'proposals',COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id',lp.id,'accountId',lp.account_id,'action',lp.action,'reason',lp.reason,
          'status',CASE WHEN lp.status='pending' AND lp.expires_at<=clock_timestamp() THEN 'expired' ELSE lp.status END,
          'createdAt',lp.created_at,'expiresAt',lp.expires_at,'reviewedAt',lp.reviewed_at,
          'mine',lp.proposer_id=actor,'newEmailHint',ertad.mask_email_hint(lp.new_email)
        ) ORDER BY lp.created_at DESC, lp.id DESC)
        FROM (
          SELECT * FROM ertad.web_account_lifecycle_proposals lp2
          WHERE (input->>'accountId' IS NULL OR lp2.account_id=(input->>'accountId')::uuid)
          ORDER BY lp2.created_at DESC, lp2.id DESC LIMIT 25
        ) lp
      ),'[]'::jsonb)
    ) INTO data;
    RETURN jsonb_build_object('data',data,'audit',audit);
  END IF;
  IF a.id IS NULL OR a.id=actor OR key IS NULL
  OR EXISTS(SELECT 1 FROM ertad.platform_accounts WHERE admin_user_id=a.id)
  OR NOT EXISTS(SELECT 1 FROM ertad.member_users WHERE web_account_id=a.id) THEN
    RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Account security action unavailable';
  END IF;
  IF op='hold' THEN
    IF input->>'reason' IS NULL OR input->>'reason' NOT IN ('suspected_compromise','credential_exposure') THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid security reason';
    END IF;
    SELECT * INTO h FROM ertad.web_account_security_holds WHERE actor_id=actor AND request_id=key;
    IF FOUND THEN
      IF h.account_id<>a.id OR h.reason IS DISTINCT FROM input->>'reason' THEN
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request key conflict';
      END IF;
    ELSE
      IF NOT a.is_active OR ertad.web_account_held(a.id) OR NOT ertad.web_security_recoverable(a.id) THEN
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Account unavailable';
      END IF;
      stamp:=date_trunc('milliseconds',clock_timestamp());
      INSERT INTO ertad.web_account_security_holds(account_id,actor_id,request_id,reason,credential_fingerprint,held_at)
      VALUES(a.id,actor,key,input->>'reason',encode(sha256(convert_to(a.password_hash,'UTF8')),'hex'),stamp) RETURNING * INTO h;
      UPDATE ertad.admin_users SET updated_at=stamp WHERE id=a.id;
      UPDATE ertad.admin_sessions SET revoked_at=COALESCE(revoked_at,stamp),step_up_expires_at=NULL WHERE admin_user_id=a.id;
      UPDATE ertad.web_account_recoveries SET revoked_at=COALESCE(revoked_at,stamp) WHERE account_id=a.id AND consumed_at IS NULL;
      UPDATE ertad.web_account_email_changes SET revoked_at=COALESCE(revoked_at,stamp) WHERE account_id=a.id AND confirmed_at IS NULL;
      UPDATE ertad.security_mail_jobs j SET token_cipher=NULL,state=CASE WHEN state IN ('queued','retry') THEN 'cancelled' ELSE state END,updated_at=stamp
      WHERE (state IN ('queued','retry') OR token_cipher IS NOT NULL) AND (
        (purpose='recovery' AND EXISTS(SELECT 1 FROM ertad.web_account_recoveries r WHERE r.id=j.source_id AND r.account_id=a.id AND r.consumed_at IS NULL))
        OR (purpose='email_change' AND EXISTS(SELECT 1 FROM ertad.web_account_email_changes e WHERE e.id=j.source_id AND e.account_id=a.id AND e.confirmed_at IS NULL))
      );
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
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Credential recovery required';
      END IF;
      UPDATE ertad.web_account_security_holds SET released_at=date_trunc('milliseconds',clock_timestamp()),released_by=actor,release_request_id=key
      WHERE id=h.id RETURNING * INTO h;
      UPDATE ertad.admin_users SET updated_at=clock_timestamp() WHERE id=a.id;
      changed:=true;
    END IF;
  END IF;
  RETURN jsonb_build_object(
    'data',jsonb_build_object('id',h.id,'accountId',a.id,'heldAt',h.held_at,'releasedAt',h.released_at),
    'audit',CASE WHEN changed THEN audit||jsonb_build_object('holdId',h.id,'targetAccountId',a.id,'requestId',key) ELSE NULL END,
    'check',jsonb_build_object('id',h.id,'accountId',a.id,'actorId',h.actor_id,'heldAt',h.held_at,'reason',h.reason,
      'releasedAt',h.released_at,'releasedBy',h.released_by,'releaseRequestId',h.release_request_id,'fingerprint',h.credential_fingerprint,'changed',changed)
  );
END $$;

CREATE FUNCTION ertad.web_lifecycle_actor(sid uuid, token text, capability text) RETURNS uuid
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE actor uuid; capabilities text[]; s ertad.admin_sessions;
BEGIN
  PERFORM ertad.platform_console_command(sid,token,'overview','{}');
  SELECT * INTO s FROM ertad.admin_sessions WHERE id=sid AND token_hash=token;
  actor:=s.admin_user_id;
  SELECT permissions INTO capabilities FROM ertad.platform_accounts WHERE admin_user_id=actor;
  IF NOT COALESCE('platform.accounts.read'=ANY(capabilities),false)
  OR NOT COALESCE(capability=ANY(capabilities),false) THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied';
  END IF;
  IF s.step_up_expires_at IS NULL OR s.step_up_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE='P0428',MESSAGE='Fresh authentication required';
  END IF;
  RETURN actor;
END $$;

CREATE FUNCTION ertad.web_lifecycle_revoke_tokens(target_account uuid, stamp timestamptz) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  UPDATE ertad.admin_sessions SET revoked_at=COALESCE(revoked_at,stamp),step_up_expires_at=NULL WHERE admin_user_id=target_account;
  UPDATE ertad.web_account_recoveries SET revoked_at=COALESCE(revoked_at,stamp) WHERE account_id=target_account AND consumed_at IS NULL;
  UPDATE ertad.web_account_email_changes SET revoked_at=COALESCE(revoked_at,stamp) WHERE account_id=target_account AND confirmed_at IS NULL;
  UPDATE ertad.security_mail_jobs j SET token_cipher=NULL,
    state=CASE WHEN state IN ('queued','retry') THEN 'cancelled' ELSE state END,updated_at=stamp
  WHERE (state IN ('queued','retry') OR token_cipher IS NOT NULL) AND (
    (purpose='recovery' AND EXISTS(SELECT 1 FROM ertad.web_account_recoveries r WHERE r.id=j.source_id AND r.account_id=target_account AND r.consumed_at IS NULL))
    OR (purpose='email_change' AND EXISTS(SELECT 1 FROM ertad.web_account_email_changes e WHERE e.id=j.source_id AND e.account_id=target_account AND e.confirmed_at IS NULL))
  );
END $$;

CREATE FUNCTION ertad.web_account_lifecycle_command(sid uuid, token text, op text, input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid; a ertad.admin_users; p ertad.web_account_lifecycle_proposals;
  key uuid:=(input->>'requestId')::uuid; target uuid; action_name text:=input->>'action';
  reason_val text:=input->>'reason'; email_val text; review_decision text:=input->>'decision';
  changed boolean:=false; stamp timestamptz; audit jsonb;
BEGIN
  IF op IS NULL OR op NOT IN ('propose','review') OR key IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid lifecycle operation';
  END IF;

  IF op='propose' THEN
    target:=(input->>'accountId')::uuid;
    SELECT * INTO a FROM ertad.admin_users WHERE id=target FOR UPDATE;
    actor:=ertad.web_lifecycle_actor(sid,token,'platform.accounts.propose');
    IF a.id IS NULL OR a.id=actor OR EXISTS(SELECT 1 FROM ertad.platform_accounts WHERE admin_user_id=a.id)
    OR NOT EXISTS(SELECT 1 FROM ertad.member_users WHERE web_account_id=a.id) THEN
      RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Account lifecycle unavailable';
    END IF;
    email_val:=CASE WHEN action_name='lost_contact_recovery' THEN lower(trim(input->>'newEmail')) ELSE NULL END;
    IF action_name IS NULL OR action_name NOT IN ('disable_account','restore_account','lost_contact_recovery','mfa_reset') THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid lifecycle action';
    END IF;
    SELECT * INTO p FROM ertad.web_account_lifecycle_proposals WHERE proposer_id=actor AND request_id=key;
    IF FOUND THEN
      IF p.account_id<>a.id OR p.action<>action_name OR p.reason<>reason_val OR p.new_email IS DISTINCT FROM email_val THEN
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request key conflict';
      END IF;
    ELSE
      IF (action_name='disable_account' AND (NOT a.is_active OR reason_val NOT IN ('policy_violation','departure')))
      OR (action_name='restore_account' AND (a.is_active OR reason_val<>'account_restoration'))
      OR (action_name='lost_contact_recovery' AND (
        NOT a.is_active OR reason_val<>'lost_contact' OR NOT ertad.web_lost_contact_eligible(a.id)
        OR email_val IS NULL OR length(email_val)>254 OR email_val=a.email
        OR email_val !~ '^[a-z0-9._%+-]+@[a-z0-9.-]+[.][a-z]{2,}$'
        OR EXISTS(SELECT 1 FROM ertad.admin_users other WHERE other.email=email_val AND other.id<>a.id)
      ))
      OR (action_name='mfa_reset' AND (
        NOT a.is_active OR reason_val NOT IN ('lost_mfa_device','mfa_compromise')
        OR (NOT a.mfa_enabled AND a.mfa_secret_encrypted IS NULL)
      )) THEN
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Account lifecycle precondition unmet';
      END IF;
      UPDATE ertad.web_account_lifecycle_proposals SET status='expired'
      WHERE account_id=a.id AND action=action_name AND status='pending' AND expires_at<=clock_timestamp();
      IF EXISTS(SELECT 1 FROM ertad.web_account_lifecycle_proposals WHERE account_id=a.id AND action=action_name AND status='pending') THEN
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Pending lifecycle proposal exists';
      END IF;
      stamp:=date_trunc('milliseconds',clock_timestamp());
      INSERT INTO ertad.web_account_lifecycle_proposals(
        account_id,action,proposer_id,request_id,reason,new_email,
        expected_active,expected_mfa_enabled,expected_mfa_provisioned,expected_email,created_at,expires_at
      ) VALUES (
        a.id,action_name,actor,key,reason_val,email_val,
        a.is_active,a.mfa_enabled,a.mfa_secret_encrypted IS NOT NULL,a.email,stamp,stamp+interval '24 hours'
      ) RETURNING * INTO p;
      changed:=true;
    END IF;
    audit:=CASE WHEN changed THEN jsonb_build_object('adminUserId',actor,'operation',p.action,'proposalId',p.id,'targetAccountId',a.id,'requestId',key) ELSE NULL END;
  ELSE
    IF review_decision IS NULL OR review_decision NOT IN ('approve','reject','withdraw') THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid review decision';
    END IF;
    SELECT * INTO p FROM ertad.web_account_lifecycle_proposals WHERE id=(input->>'proposalId')::uuid FOR UPDATE;
    IF p.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Lifecycle proposal unavailable'; END IF;
    SELECT * INTO a FROM ertad.admin_users WHERE id=p.account_id FOR UPDATE;
    actor:=ertad.web_lifecycle_actor(sid,token,CASE WHEN review_decision='withdraw' THEN 'platform.accounts.propose' ELSE 'platform.accounts.approve' END);
    IF a.id IS NULL OR a.id=actor OR EXISTS(SELECT 1 FROM ertad.platform_accounts WHERE admin_user_id=a.id)
    OR NOT EXISTS(SELECT 1 FROM ertad.member_users WHERE web_account_id=a.id) THEN
      RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Account lifecycle unavailable';
    END IF;
    IF (review_decision='withdraw' AND p.proposer_id<>actor) OR (review_decision<>'withdraw' AND p.proposer_id=actor) THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Independent review required';
    END IF;
    IF p.status<>'pending' THEN
      IF p.status=(CASE review_decision WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE 'withdrawn' END)
      AND p.reviewer_id=actor AND p.review_request_id=key THEN
        RETURN jsonb_build_object(
          'data',jsonb_build_object('id',p.id,'accountId',p.account_id,'action',p.action,'status',p.status,'reviewedAt',p.reviewed_at),
          'audit',NULL,
          'check',jsonb_build_object('id',p.id,'accountId',p.account_id,'action',p.action,'status',p.status,'proposerId',p.proposer_id,
            'reviewerId',p.reviewer_id,'reviewRequestId',p.review_request_id,'reviewedAt',p.reviewed_at,'changed',false)
        );
      END IF;
      RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Lifecycle proposal already resolved';
    END IF;
    IF review_decision='approve' AND p.expires_at<=clock_timestamp() THEN
      RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Lifecycle proposal expired';
    END IF;
    IF review_decision='approve' THEN
      IF NOT EXISTS(
        SELECT 1 FROM ertad.platform_accounts pr JOIN ertad.admin_users pa ON pa.id=pr.admin_user_id
        WHERE pr.admin_user_id=p.proposer_id AND pr.revoked_at IS NULL
        AND pr.valid_from<=clock_timestamp() AND pr.valid_until>clock_timestamp()
        AND ARRAY['platform.read','platform.accounts.read','platform.accounts.propose'] <@ pr.permissions
        AND pa.is_active AND (pa.locked_until IS NULL OR pa.locked_until<=clock_timestamp())
      ) THEN
        RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Proposer authority unavailable';
      END IF;
      IF a.is_active IS DISTINCT FROM p.expected_active
      OR a.mfa_enabled IS DISTINCT FROM p.expected_mfa_enabled
      OR (a.mfa_secret_encrypted IS NOT NULL) IS DISTINCT FROM p.expected_mfa_provisioned
      OR a.email IS DISTINCT FROM p.expected_email THEN
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Account state changed since proposal';
      END IF;
      stamp:=date_trunc('milliseconds',clock_timestamp());
      IF p.action='disable_account' THEN
        UPDATE ertad.admin_users SET is_active=false,updated_at=stamp WHERE id=a.id;
        PERFORM ertad.web_lifecycle_revoke_tokens(a.id,stamp);
      ELSIF p.action='restore_account' THEN
        UPDATE ertad.admin_users SET is_active=true,updated_at=stamp WHERE id=a.id;
      ELSIF p.action='lost_contact_recovery' THEN
        IF NOT ertad.web_lost_contact_eligible(a.id)
        OR EXISTS(SELECT 1 FROM ertad.admin_users other WHERE other.email=p.new_email AND other.id<>a.id) THEN
          RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Lost-contact eligibility changed';
        END IF;
        UPDATE ertad.admin_users SET email=p.new_email,updated_at=stamp WHERE id=a.id;
        PERFORM ertad.web_lifecycle_revoke_tokens(a.id,stamp);
      ELSIF p.action='mfa_reset' THEN
        UPDATE ertad.admin_users
        SET mfa_enabled=false,mfa_secret_encrypted=NULL,mfa_enrolled_at=NULL,mfa_last_counter=-1,updated_at=stamp
        WHERE id=a.id;
        PERFORM ertad.web_lifecycle_revoke_tokens(a.id,stamp);
      END IF;
    ELSE
      stamp:=date_trunc('milliseconds',clock_timestamp());
    END IF;
    UPDATE ertad.web_account_lifecycle_proposals
    SET status=CASE review_decision WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE 'withdrawn' END,
        reviewer_id=actor,review_request_id=key,reviewed_at=stamp
    WHERE id=p.id RETURNING * INTO p;
    changed:=true;
    audit:=jsonb_build_object('adminUserId',actor,'operation',p.action,'decision',review_decision,'proposalId',p.id,'targetAccountId',a.id,'requestId',key);
  END IF;

  RETURN jsonb_build_object(
    'data',jsonb_build_object('id',p.id,'accountId',p.account_id,'action',p.action,'status',p.status,'reviewedAt',p.reviewed_at),
    'audit',audit,
    'check',jsonb_build_object('id',p.id,'accountId',p.account_id,'action',p.action,'status',p.status,'proposerId',p.proposer_id,
      'reviewerId',p.reviewer_id,'reviewRequestId',p.review_request_id,'reviewedAt',p.reviewed_at,'changed',changed)
  );
END $$;

CREATE FUNCTION ertad.web_account_lifecycle_finish(sid uuid, token text, op text, expected jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p ertad.web_account_lifecycle_proposals; a ertad.admin_users; actor uuid;
BEGIN
  SELECT * INTO p FROM ertad.web_account_lifecycle_proposals WHERE id=(expected->>'id')::uuid FOR UPDATE;
  SELECT * INTO a FROM ertad.admin_users WHERE id=(expected->>'accountId')::uuid FOR UPDATE;
  actor:=ertad.web_lifecycle_actor(
    sid,
    token,
    CASE WHEN op='propose' THEN 'platform.accounts.propose'
         WHEN expected->>'status'='withdrawn' THEN 'platform.accounts.propose'
         ELSE 'platform.accounts.approve' END
  );
  IF p.id IS NULL OR a.id IS NULL OR a.id=actor
  OR EXISTS(SELECT 1 FROM ertad.platform_accounts WHERE admin_user_id=a.id)
  OR NOT EXISTS(SELECT 1 FROM ertad.member_users WHERE web_account_id=a.id)
  OR p.account_id IS DISTINCT FROM a.id OR p.action IS DISTINCT FROM expected->>'action'
  OR p.status IS DISTINCT FROM expected->>'status' OR p.proposer_id IS DISTINCT FROM (expected->>'proposerId')::uuid
  OR p.reviewer_id IS DISTINCT FROM (expected->>'reviewerId')::uuid
  OR p.review_request_id IS DISTINCT FROM (expected->>'reviewRequestId')::uuid
  OR p.reviewed_at IS DISTINCT FROM (expected->>'reviewedAt')::timestamptz THEN
    RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Account lifecycle state changed during audit';
  END IF;

  IF expected->>'changed'='true' AND p.status='approved' THEN
    IF p.reviewer_id=p.proposer_id OR p.reviewer_id=a.id OR p.reviewer_id<>actor
    OR NOT EXISTS(
      SELECT 1 FROM ertad.platform_accounts pr JOIN ertad.admin_users pa ON pa.id=pr.admin_user_id
      WHERE pr.admin_user_id=p.proposer_id AND pr.revoked_at IS NULL
      AND pr.valid_from<=clock_timestamp() AND pr.valid_until>clock_timestamp()
      AND ARRAY['platform.read','platform.accounts.read','platform.accounts.propose'] <@ pr.permissions
      AND pa.is_active AND (pa.locked_until IS NULL OR pa.locked_until<=clock_timestamp())
    ) THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Authority changed during audit';
    END IF;
    IF (p.action='disable_account' AND a.is_active)
    OR (p.action='restore_account' AND NOT a.is_active)
    OR (p.action='lost_contact_recovery' AND a.email IS DISTINCT FROM p.new_email)
    OR (p.action='mfa_reset' AND (a.mfa_enabled OR a.mfa_secret_encrypted IS NOT NULL OR a.mfa_enrolled_at IS NOT NULL OR a.mfa_last_counter<>-1)) THEN
      RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Lifecycle transition failed final check';
    END IF;
    IF p.action IN ('disable_account','lost_contact_recovery','mfa_reset') AND (
      EXISTS(SELECT 1 FROM ertad.admin_sessions WHERE admin_user_id=a.id AND (revoked_at IS NULL OR step_up_expires_at IS NOT NULL))
      OR EXISTS(SELECT 1 FROM ertad.web_account_recoveries WHERE account_id=a.id AND consumed_at IS NULL AND revoked_at IS NULL)
      OR EXISTS(SELECT 1 FROM ertad.web_account_email_changes WHERE account_id=a.id AND confirmed_at IS NULL AND revoked_at IS NULL)
      OR EXISTS(SELECT 1 FROM ertad.security_mail_jobs j WHERE (j.state IN ('queued','retry') OR j.token_cipher IS NOT NULL) AND (
        (j.purpose='recovery' AND EXISTS(SELECT 1 FROM ertad.web_account_recoveries r WHERE r.id=j.source_id AND r.account_id=a.id AND r.consumed_at IS NULL))
        OR (j.purpose='email_change' AND EXISTS(SELECT 1 FROM ertad.web_account_email_changes e WHERE e.id=j.source_id AND e.account_id=a.id AND e.confirmed_at IS NULL))
      ))
    ) THEN
      RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Lifecycle token revocation failed final check';
    END IF;
  END IF;
END $$;

REVOKE ALL ON FUNCTION ertad.web_lifecycle_actor(uuid,text,text), ertad.web_lifecycle_revoke_tokens(uuid,timestamptz) FROM PUBLIC, ertad_app;
REVOKE ALL ON FUNCTION ertad.web_account_lifecycle_command(uuid,text,text,jsonb), ertad.web_account_lifecycle_finish(uuid,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.web_account_lifecycle_command(uuid,text,text,jsonb), ertad.web_account_lifecycle_finish(uuid,text,text,jsonb) TO ertad_app;

-- Surface sanitized lifecycle proposal/review events in technical audit log without PII.
DO $$ DECLARE body text; old text; BEGIN
  SELECT pg_get_functiondef('ertad.platform_console_command(uuid,text,text,jsonb)'::regprocedure) INTO body; old:=body;
  body:=replace(body,'''PLATFORM_ACCOUNT_RELEASED''','''PLATFORM_ACCOUNT_RELEASED'',''PLATFORM_ACCOUNT_LIFECYCLE_PROPOSED'',''PLATFORM_ACCOUNT_LIFECYCLE_REVIEWED''');
  IF body=old THEN RAISE EXCEPTION 'Technical audit extension point for account lifecycle changed'; END IF;
  EXECUTE body;
END $$;

