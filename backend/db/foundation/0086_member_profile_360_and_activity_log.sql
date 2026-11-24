-- Migration 0086: Member 360 Profile & Unified Scoped Activity/Audit Log
-- Provides authorized scoped admins with a privacy-safe 360-degree view of a member:
-- alphanumeric handle, masked contact & Google accounts, trusted mobile devices,
-- and a unified chronological activity/audit log (verification, tasks, points, audit)
-- without exposing ballot choices or unencrypted secrets.

CREATE OR REPLACE FUNCTION ertad.member_directory_profile_360(
  sid uuid,
  token text,
  org_id uuid,
  target_member_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid;
  anon_code text := '';
  contact ertad.member_contact_profiles%ROWTYPE;
  web_email text := '';
  has_web boolean := false;
  google_arr jsonb := '[]'::jsonb;
  devices_arr jsonb := '[]'::jsonb;
  activity_arr jsonb := '[]'::jsonb;
BEGIN
  actor := ertad.review_identity(sid, token, false);
  IF target_member_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM ertad.member_memberships(actor, org_id, target_member_id, NULL)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
  END IF;

  anon_code := ertad.member_anon_code(org_id, target_member_id);

  SELECT
    (mu.web_account_id IS NOT NULL),
    COALESCE(au.email, '')
  INTO has_web, web_email
  FROM ertad.member_users mu
  LEFT JOIN ertad.admin_users au ON au.id = mu.web_account_id
  WHERE mu.id = target_member_id;

  SELECT * INTO contact
  FROM ertad.member_contact_profiles
  WHERE member_id = target_member_id;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', a.id,
        'emailHint', a.email_hint,
        'isPrimary', a.is_primary,
        'linkedAt', a.linked_at
      )
      ORDER BY a.is_primary DESC, a.linked_at ASC
    ),
    '[]'::jsonb
  )
  INTO google_arr
  FROM ertad.member_google_accounts a
  WHERE a.member_id = target_member_id;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', d.id,
        'platform', d.platform,
        'appId', d.app_id,
        'verdict', d.attestation_verdict,
        'status', d.status,
        'lastAttestedAt', d.last_attested_at,
        'createdAt', d.created_at
      )
      ORDER BY d.created_at DESC
    ),
    '[]'::jsonb
  )
  INTO devices_arr
  FROM (
    SELECT id, platform, app_id, attestation_verdict, status, last_attested_at, created_at
    FROM ertad.mobile_device_bindings
    WHERE member_id = target_member_id
    ORDER BY created_at DESC
    LIMIT 10
  ) d;

  WITH combined AS (
    -- 1. Biometric / eID / Selfie verification sessions
    SELECT
      'ver:' || s.id::text AS id,
      'verification'::text AS category,
      CASE
        WHEN s.session_kind = 'reauth' THEN 'selfie_reauth'
        ELSE 'eid_verification'
      END AS action,
      s.status::text AS status,
      CASE
        WHEN s.face_match_score IS NOT NULL THEN
          'face=' || round((s.face_match_score * 100)::numeric)::text || '%' ||
          CASE WHEN s.liveness_score IS NOT NULL THEN ' · liveness=' || round((s.liveness_score * 100)::numeric)::text || '%' ELSE '' END
        ELSE ''
      END AS summary,
      s.created_at AS occurred_at
    FROM ertad.biometric_verification_sessions s
    WHERE s.member_id = target_member_id
      AND s.status <> 'purged'

    UNION ALL

    -- 2. Scoped work events involving this member
    SELECT
      'work:' || we.work_id::text || ':' || we.version::text AS id,
      'work'::text AS category,
      we.action::text AS action,
      'recorded'::text AS status,
      COALESCE(wi.title, '') || CASE WHEN we.note <> '' THEN ' — ' || left(we.note, 120) ELSE '' END AS summary,
      we.created_at AS occurred_at
    FROM ertad.work_events we
    JOIN ertad.work_items wi
      ON wi.organization_id = we.organization_id AND wi.id = we.work_id
    WHERE we.organization_id = org_id
      AND (we.actor_id = target_member_id OR we.subject_id = target_member_id)

    UNION ALL

    -- 3. Scoped contribution point awards/reversals
    SELECT
      'pts:' || ce.id::text AS id,
      'points'::text AS category,
      ce.kind || ':' || ce.category AS action,
      CASE WHEN ce.points >= 0 THEN '+' || ce.points::text ELSE ce.points::text END AS status,
      COALESCE(NULLIF(left(ce.reason, 120), ''), ce.category) AS summary,
      ce.earned_on::timestamptz AS occurred_at
    FROM ertad.contribution_entries ce
    WHERE ce.organization_id = org_id
      AND ce.user_id = target_member_id

    UNION ALL

    -- 4. Scoped security/directory audit entries referencing this member
    SELECT
      'aud:' || al.id::text AS id,
      'audit'::text AS category,
      al.event_type::text AS action,
      'logged'::text AS status,
      COALESCE(al.payload::jsonb->>'reason', al.payload::jsonb->>'operation', al.event_type) AS summary,
      al.created_at::timestamptz AS occurred_at
    FROM ertad.audit_log al
    WHERE (al.payload::jsonb->>'targetMemberId' = target_member_id::text
           OR al.payload::jsonb->>'memberId' = target_member_id::text)
      AND (al.payload::jsonb->>'organizationId' IS NULL OR al.payload::jsonb->>'organizationId' = org_id::text)
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', c.id,
        'category', c.category,
        'action', c.action,
        'status', c.status,
        'summary', c.summary,
        'occurredAt', c.occurred_at
      )
      ORDER BY c.occurred_at DESC
    ),
    '[]'::jsonb
  )
  INTO activity_arr
  FROM (
    SELECT * FROM combined
    ORDER BY occurred_at DESC
    LIMIT 40
  ) c;

  RETURN jsonb_build_object(
    'anonCode', COALESCE(anon_code, ''),
    'hasWebAccount', COALESCE(has_web, false),
    'webEmail', COALESCE(web_email, ''),
    'hasPhone', (contact.phone_cipher IS NOT NULL),
    'phoneHint', COALESCE(contact.phone_hint, ''),
    'phoneUpdatedAt', contact.updated_at,
    'linkedGoogleAccounts', google_arr,
    'devices', devices_arr,
    'activityLog', activity_arr
  );
END;
$$;

REVOKE ALL ON FUNCTION ertad.member_directory_profile_360(uuid, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.member_directory_profile_360(uuid, text, uuid, uuid) TO ertad_app;
