-- Personal credential rotation grants no organizational or technical authority.
-- Keep direct password writes unavailable to the application role.
CREATE FUNCTION ertad.replace_own_admin_password(sid uuid,token text,previous_hash text,next_hash text)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s ertad.admin_sessions; a ertad.admin_users; changed_at timestamptz;
BEGIN
 SELECT * INTO s FROM ertad.admin_sessions WHERE id=sid AND token_hash=token FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 SELECT * INTO a FROM ertad.admin_users WHERE id=s.admin_user_id FOR UPDATE;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint);
 IF NOT a.is_active OR a.locked_until>clock_timestamp() OR s.revoked_at IS NOT NULL
 OR s.idle_expires_at<=clock_timestamp() OR s.absolute_expires_at<=clock_timestamp() THEN
 RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 IF s.step_up_expires_at IS NULL OR s.step_up_expires_at<=clock_timestamp() THEN
 RAISE EXCEPTION USING ERRCODE='P0428',MESSAGE='Fresh authentication required'; END IF;
 IF previous_hash IS DISTINCT FROM a.password_hash THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Credential changed'; END IF;
 IF next_hash IS NULL OR next_hash=previous_hash OR next_hash !~ '^\$2[aby]\$(10|11|12|13|14)\$[./A-Za-z0-9]{53}$' THEN
 RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid credential'; END IF;
 changed_at:=date_trunc('milliseconds',clock_timestamp());
 UPDATE ertad.admin_users SET password_hash=next_hash,password_changed_at=changed_at,updated_at=changed_at WHERE id=a.id;
 UPDATE ertad.admin_sessions SET revoked_at=COALESCE(revoked_at,changed_at),step_up_expires_at=NULL WHERE admin_user_id=a.id;
 RETURN changed_at;
END $$;
REVOKE ALL ON FUNCTION ertad.replace_own_admin_password(uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.replace_own_admin_password(uuid,text,text,text) TO ertad_app;
