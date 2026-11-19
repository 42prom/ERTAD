-- A signed-in account can inspect/cancel its own recovery request, never another's.
CREATE FUNCTION ertad.own_web_recovery(sid uuid,token text,operation text,target uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s ertad.admin_sessions; a ertad.admin_users; r ertad.web_account_recoveries; available boolean;
BEGIN
 IF operation IS NULL OR operation NOT IN ('read','cancel','confirm') OR
 (operation='read' AND target IS NOT NULL) OR (operation<>'read' AND target IS NULL) THEN
 RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid request'; END IF;
 SELECT * INTO s FROM ertad.admin_sessions WHERE id=sid AND token_hash=token FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 SELECT * INTO a FROM ertad.admin_users WHERE id=s.admin_user_id FOR UPDATE;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint);
 IF NOT a.is_active OR a.locked_until>clock_timestamp() OR s.revoked_at IS NOT NULL
 OR s.idle_expires_at<=clock_timestamp() OR s.absolute_expires_at<=clock_timestamp() THEN
 RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 IF operation<>'read' THEN
  IF s.step_up_expires_at IS NULL OR s.step_up_expires_at<=clock_timestamp() THEN
   RAISE EXCEPTION USING ERRCODE='P0428',MESSAGE='Fresh authentication required'; END IF;
  SELECT * INTO r FROM ertad.web_account_recoveries WHERE id=target AND account_id=a.id FOR UPDATE;
  IF NOT FOUND OR r.consumed_at IS NOT NULL THEN
   RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Recovery unavailable'; END IF;
  IF operation='cancel' THEN
   UPDATE ertad.web_account_recoveries SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=r.id;
  ELSIF r.revoked_at IS NULL THEN
   RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Recovery changed'; END IF;
  RETURN jsonb_build_object('cancelled',true);
 END IF;
 SELECT EXISTS(SELECT 1 FROM ertad.web_invite_contacts c WHERE c.email=a.email
  AND ertad.web_recovery_eligible(a.id,c.organization_id,c.id)) INTO available;
 SELECT * INTO r FROM ertad.web_account_recoveries WHERE account_id=a.id
  AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp()
  AND credential_fingerprint=encode(sha256(convert_to(a.password_hash,'UTF8')),'hex')
  AND ertad.web_recovery_eligible(a.id,organization_id,contact_id);
 RETURN jsonb_build_object('available',available,'pending',CASE WHEN r.id IS NULL THEN NULL ELSE
  jsonb_build_object('id',r.id,'createdAt',r.created_at,'expiresAt',r.expires_at,'delivered',r.delivered_at IS NOT NULL) END);
END $$;
REVOKE ALL ON FUNCTION ertad.own_web_recovery(uuid,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.own_web_recovery(uuid,text,text,uuid) TO ertad_app;
