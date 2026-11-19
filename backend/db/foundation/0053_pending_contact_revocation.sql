-- Revoke an unactivated recipient binding; never modify a bound account or replacement contact.
CREATE FUNCTION ertad.web_contact_revoke(sid uuid,token text,org uuid,target_contact uuid,checking boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid; c ertad.web_invite_contacts; m ertad.member_users; changed boolean;
BEGIN
 actor:=ertad.review_identity(sid,token,true);
 PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint);
 PERFORM ertad.review_identity(sid,token,true);
 SELECT * INTO c FROM ertad.web_invite_contacts WHERE organization_id=org AND id=target_contact FOR UPDATE;
 SELECT * INTO m FROM ertad.member_users WHERE id=c.member_id FOR UPDATE;
 IF c.id IS NULL OR c.source<>'email' OR m.status IS DISTINCT FROM 'active' OR m.web_account_id IS NOT NULL
 OR m.id=actor OR ertad.unit_path(org,c.unit_id) IS NULL
 OR NOT ertad.collective_actor(actor,org,c.unit_id,'account_invite',false)
 OR NOT EXISTS(SELECT 1 FROM ertad.memberships ms WHERE ms.organization_id=org AND ms.user_id=m.id AND ms.unit_id=c.unit_id AND ertad.member_membership_state(ms)='active') THEN
 RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Pending contact unavailable'; END IF;
 changed:=c.revoked_at IS NULL;
 IF checking THEN
 IF changed OR EXISTS(SELECT 1 FROM ertad.web_invitations WHERE organization_id=org AND contact_id=c.id AND consumed_at IS NULL AND revoked_at IS NULL)
 OR EXISTS(SELECT 1 FROM ertad.security_mail_jobs j JOIN ertad.web_invitations i ON i.id=j.source_id
  WHERE i.organization_id=org AND i.contact_id=c.id AND j.purpose IN ('contact','invitation')
  AND (j.state IN ('queued','retry') OR j.token_cipher IS NOT NULL)) THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Contact revocation changed during audit'; END IF;
 ELSE
 UPDATE ertad.web_invite_contacts SET revoked_at=clock_timestamp() WHERE organization_id=org AND id=c.id AND revoked_at IS NULL;
 UPDATE ertad.web_invitations SET revoked_at=clock_timestamp() WHERE organization_id=org AND contact_id=c.id AND consumed_at IS NULL AND revoked_at IS NULL;
 UPDATE ertad.security_mail_jobs j SET token_cipher=NULL,
 state=CASE WHEN j.state IN ('queued','retry') THEN 'cancelled' ELSE j.state END,updated_at=clock_timestamp()
 WHERE j.purpose IN ('contact','invitation') AND (j.state IN ('queued','retry') OR j.token_cipher IS NOT NULL)
 AND EXISTS(SELECT 1 FROM ertad.web_invitations i WHERE i.id=j.source_id AND i.organization_id=org AND i.contact_id=c.id);
 END IF;
 RETURN jsonb_build_object('data',jsonb_build_object('id',c.id,'revoked',true),'changed',changed,
 'audit',jsonb_build_object('actorId',actor,'organizationId',org,'contactId',c.id));
END $$;
REVOKE ALL ON FUNCTION ertad.web_contact_revoke(uuid,text,uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.web_contact_revoke(uuid,text,uuid,uuid,boolean) TO ertad_app;
DO $$ DECLARE body text; old text; BEGIN
 SELECT pg_get_functiondef('ertad.web_invite_command(uuid,text,text,uuid,jsonb)'::regprocedure) INTO body;old:=body;
 body:=replace(body,'left(c.email,2)||''…@…'' AS "contactHint"','left(c.email,2)||''…@…'' AS "contactHint",c.source AS "source"');
 IF body=old THEN RAISE EXCEPTION 'Contact source projection extension point changed'; END IF;EXECUTE body;
END $$;
