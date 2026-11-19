-- Preserve the existing minimal session contract for readers without account access.
DO $$ DECLARE body text; old text; BEGIN
 SELECT pg_get_functiondef('ertad.platform_session_command(uuid,text,text,jsonb)'::regprocedure) INTO body;old:=body;
 body:=replace(body,'jsonb_agg(jsonb_build_object(','jsonb_agg(jsonb_strip_nulls(jsonb_build_object(');
 IF body=old THEN RAISE EXCEPTION 'Session object projection changed'; END IF;old:=body;
 body:=replace(body,'absolute_expires_at)) ORDER BY id DESC','absolute_expires_at))) ORDER BY id DESC');
 IF body=old THEN RAISE EXCEPTION 'Session object boundary changed'; END IF;EXECUTE body;
END $$;
