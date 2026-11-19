-- Reviewed web activation for existing members. No appointments or automatic grants.
ALTER TABLE ertad.permission_grants DROP CONSTRAINT permission_grants_permission_check;
ALTER TABLE ertad.permission_grants ADD CONSTRAINT permission_grants_permission_check CHECK(permission IN (
 'unit.read','member.read','workitem.create','workitem.verify','workitem.read','workitem.participate',
 'membership.propose','membership.approve','unit.propose','unit.approve','unit.change.propose','unit.change.approve',
 'decision.read','decision.manage','decision.publish','decision.vote','qualification.verify',
 'governance.propose','governance.vote','governance.manage','finance.read','finance.record','finance.approve',
 'contribution.manage','contribution.award','contribution.read','channel.read','channel.post','channel.manage','channel.moderate',
 'position.propose','position.approve','account.invite.propose','account.invite.approve'));

-- Only offline synthetic contacts are available in this local-first slice. There is
-- no endpoint to invent verified person/contact binding or to change a destination.
CREATE TABLE ertad.web_invite_contacts (
 organization_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
 unit_id uuid NOT NULL, member_id uuid NOT NULL REFERENCES ertad.member_users(id),
 email text NOT NULL CHECK(email=lower(trim(email)) AND email ~ '^[a-z0-9._+-]+@example[.]invalid$'),
 source text NOT NULL DEFAULT 'synthetic' CHECK(source='synthetic'),
 expires_at timestamptz NOT NULL CHECK(isfinite(expires_at)), revoked_at timestamptz,
 PRIMARY KEY(organization_id,id), UNIQUE(organization_id,id,unit_id),
 FOREIGN KEY(organization_id,unit_id) REFERENCES ertad.units(organization_id,id)
);
CREATE FUNCTION ertad.freeze_invite_contact() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF to_jsonb(NEW)-'revoked_at' IS DISTINCT FROM to_jsonb(OLD)-'revoked_at'
 OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
 RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Contact bindings are immutable; revoke and replace'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER a_serialize BEFORE INSERT OR UPDATE OR DELETE ON ertad.web_invite_contacts
 FOR EACH ROW EXECUTE FUNCTION ertad.serialize_authority_change();
CREATE TRIGGER b_freeze BEFORE UPDATE ON ertad.web_invite_contacts FOR EACH ROW EXECUTE FUNCTION ertad.freeze_invite_contact();
CREATE TABLE ertad.web_invitations (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, contact_id uuid NOT NULL,
 token_hash text UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
 expires_at timestamptz, delivered_at timestamptz, revoked_at timestamptz,
 consumed_at timestamptz, account_id uuid UNIQUE REFERENCES ertad.admin_users(id),
 FOREIGN KEY(organization_id,id) REFERENCES ertad.collective_proposals(organization_id,id),
 FOREIGN KEY(organization_id,contact_id) REFERENCES ertad.web_invite_contacts(organization_id,id),
 CHECK((token_hash IS NULL AND expires_at IS NULL AND delivered_at IS NULL)
    OR (token_hash IS NOT NULL AND expires_at IS NOT NULL AND isfinite(expires_at) AND delivered_at IS NOT NULL)),
 CHECK((consumed_at IS NULL)=(account_id IS NULL))
);
CREATE INDEX web_invitations_scope ON ertad.web_invitations(organization_id,contact_id);
REVOKE ALL ON ertad.web_invite_contacts,ertad.web_invitations FROM PUBLIC,ertad_app;

ALTER FUNCTION ertad.collective_actor(uuid,uuid,uuid,text,boolean) RENAME TO collective_before_invites_actor;
CREATE FUNCTION ertad.collective_actor(actor uuid,org uuid,target uuid,kind text,reviewer boolean) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN kind='account_invite' THEN ertad.review_has_scope(actor,org,target,'unit.read')
 AND ertad.review_has_scope(actor,org,target,CASE WHEN reviewer THEN 'account.invite.approve' ELSE 'account.invite.propose' END)
 AND ertad.review_has_scope(actor,org,target,CASE WHEN reviewer THEN 'governance.vote' ELSE 'governance.propose' END)
 ELSE ertad.collective_before_invites_actor(actor,org,target,kind,reviewer) END
$$;
ALTER FUNCTION ertad.collective_visible(uuid,ertad.collective_proposals) RENAME TO collective_before_invites_visible;
CREATE FUNCTION ertad.collective_visible(actor uuid,p ertad.collective_proposals) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT ertad.collective_before_invites_visible(actor,p) AND (p.kind<>'account_invite'
 OR ertad.collective_actor(actor,p.organization_id,p.unit_id,p.kind,false)
 OR ertad.collective_actor(actor,p.organization_id,p.unit_id,p.kind,true))
$$;
CREATE FUNCTION ertad.web_invite_validate(org uuid,target uuid,data jsonb,linked uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE c ertad.web_invite_contacts; member ertad.member_users;
BEGIN
 IF jsonb_typeof(data) IS DISTINCT FROM 'object' OR data-'contactId'<>'{}'::jsonb OR data->>'contactId' IS NULL THEN
 RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Contact reference required'; END IF;
 SELECT * INTO c FROM ertad.web_invite_contacts WHERE organization_id=org AND id=(data->>'contactId')::uuid AND unit_id=target;
 IF NOT FOUND OR c.revoked_at IS NOT NULL OR c.expires_at<=clock_timestamp() OR ertad.unit_path(org,target) IS NULL THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Contact unavailable'; END IF;
 SELECT * INTO member FROM ertad.member_users WHERE id=c.member_id FOR UPDATE;
 IF member.status IS DISTINCT FROM 'active' OR member.web_account_id IS DISTINCT FROM linked
 OR NOT EXISTS(SELECT 1 FROM ertad.memberships m WHERE m.organization_id=org AND m.user_id=member.id
  AND m.unit_id=target AND ertad.member_membership_state(m)='active')
 OR EXISTS(SELECT 1 FROM ertad.admin_users a WHERE a.email=c.email AND a.id IS DISTINCT FROM linked) THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Member or account unavailable'; END IF;
 RETURN c.member_id;
END $$;

ALTER FUNCTION ertad.collective_view(uuid,ertad.collective_proposals) RENAME TO collective_before_invites_view;
CREATE FUNCTION ertad.collective_view(actor uuid,p ertad.collective_proposals) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT ertad.collective_before_invites_view(actor,p) || jsonb_build_object('invitationRecipient',
 CASE WHEN p.kind='account_invite' AND ertad.collective_visible(actor,p) THEN
 (SELECT jsonb_build_object('displayName',l.display_name,'unitName',u.name,'contactHint',left(c.email,2)||'…@example.invalid')
 FROM ertad.web_invite_contacts c JOIN ertad.units u ON (u.organization_id,u.id)=(c.organization_id,c.unit_id)
 LEFT JOIN ertad.organization_member_labels l ON (l.organization_id,l.member_id)=(c.organization_id,c.member_id)
 WHERE c.organization_id=p.organization_id AND c.id=(p.parameters->>'contactId')::uuid)
 ELSE NULL END)
$$;
REVOKE ALL ON FUNCTION ertad.collective_before_invites_view(uuid,ertad.collective_proposals),
 ertad.collective_view(uuid,ertad.collective_proposals) FROM PUBLIC,ertad_app;

-- Extend the retained collective command at explicit, checked extension points;
-- receipts, thresholds, notifications and independent-review behavior are reused.
DO $migration$
DECLARE body text; old text;
BEGIN
 SELECT pg_get_functiondef('ertad.collective_before_recognition_command(uuid,text,text,uuid,jsonb)'::regprocedure) INTO body;
 old:=body;
 body:=replace(body,'''position_revision'',''position_retire'') THEN RAISE',
                     '''position_revision'',''position_retire'',''account_invite'') THEN RAISE');
 IF body=old THEN RAISE EXCEPTION 'Invitation kind extension point changed'; END IF;
 old:=body;
 body:=replace(body,'IF kind LIKE ''points_%'' THEN',
 'IF kind=''account_invite'' THEN beneficiary:=ertad.web_invite_validate(org,target,data); IF beneficiary=actor THEN RAISE EXCEPTION USING ERRCODE=''42501'',MESSAGE=''Independent subject required''; END IF; END IF; IF kind LIKE ''points_%'' THEN');
 IF body=old THEN RAISE EXCEPTION 'Invitation beneficiary extension point changed'; END IF;
 EXECUTE body;
END $migration$;

ALTER FUNCTION ertad.collective_apply(ertad.collective_proposals) RENAME TO collective_before_invites_apply;
CREATE FUNCTION ertad.collective_apply(p ertad.collective_proposals) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF p.kind<>'account_invite' THEN PERFORM ertad.collective_before_invites_apply(p); RETURN; END IF;
 PERFORM ertad.web_invite_validate(p.organization_id,p.unit_id,p.parameters);
 INSERT INTO ertad.web_invitations(id,organization_id,contact_id) VALUES(p.id,p.organization_id,(p.parameters->>'contactId')::uuid);
END $$;
ALTER FUNCTION ertad.collective_finish(uuid,text,text,uuid,jsonb,boolean) RENAME TO collective_before_invites_finish;
CREATE FUNCTION ertad.collective_finish(sid uuid,token text,op text,org uuid,input jsonb,changed boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p ertad.collective_proposals;
BEGIN
 PERFORM ertad.collective_before_invites_finish(sid,token,op,org,input,changed);
 SELECT * INTO p FROM ertad.collective_proposals WHERE organization_id=org AND id=CASE WHEN op='propose' THEN
 (SELECT (response->>'id')::uuid FROM ertad.collective_receipts WHERE organization_id=org AND actor_id=ertad.review_identity(sid,token,true) AND key=(input->>'key')::uuid)
 ELSE (input->>'id')::uuid END;
 IF p.kind='account_invite' AND changed AND (op='propose' OR (op='vote' AND input->>'choice'='approve')) THEN
 PERFORM ertad.web_invite_validate(org,p.unit_id,p.parameters);
 IF p.status='approved' AND NOT EXISTS(SELECT 1 FROM ertad.web_invitations WHERE id=p.id AND organization_id=org AND contact_id=(p.parameters->>'contactId')::uuid AND token_hash IS NULL AND consumed_at IS NULL AND revoked_at IS NULL) THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Invitation changed during audit'; END IF;
 END IF;
END $$;

CREATE FUNCTION ertad.web_invite_live(i ertad.web_invitations,linked uuid DEFAULT NULL) RETURNS ertad.web_invite_contacts
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE p ertad.collective_proposals; c ertad.web_invite_contacts;
BEGIN
 SELECT * INTO p FROM ertad.collective_proposals WHERE organization_id=i.organization_id AND id=i.id;
 IF i.revoked_at IS NOT NULL OR p.status IS DISTINCT FROM 'approved' OR p.deadline<=clock_timestamp()
 OR p.scope_path IS DISTINCT FROM ertad.unit_path(p.organization_id,p.unit_id)
 OR NOT ertad.collective_actor(p.proposer_id,p.organization_id,p.unit_id,'account_invite',false)
 OR ertad.collective_yes(p)<p.threshold THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Invitation unavailable'; END IF;
 PERFORM ertad.web_invite_validate(i.organization_id,p.unit_id,p.parameters,linked);
 SELECT * INTO c FROM ertad.web_invite_contacts WHERE organization_id=i.organization_id AND id=i.contact_id;
 RETURN c;
END $$;

CREATE FUNCTION ertad.web_invite_command(sid uuid,token text,op text,org uuid,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_column
DECLARE actor uuid; result jsonb; page integer:=COALESCE((input->>'page')::integer,1); i ertad.web_invitations; p ertad.collective_proposals;
BEGIN
 IF op NOT IN ('contexts','contacts','list','revoke','revoke_check') OR page NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid invitation query'; END IF;
 actor:=ertad.review_identity(sid,token,op IN ('revoke','revoke_check'));
 IF op='contexts' THEN PERFORM 1 FROM ertad.organizations ORDER BY id FOR SHARE;
 ELSE PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF; END IF;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint);
 PERFORM ertad.review_identity(sid,token,op IN ('revoke','revoke_check'));
 IF op='contexts' THEN
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',o.id,'name',o.name)),'[]') INTO result FROM ertad.organizations o WHERE o.status='active'
 AND EXISTS(SELECT 1 FROM ertad.units u WHERE u.organization_id=o.id AND (ertad.collective_actor(actor,o.id,u.id,'account_invite',false) OR ertad.collective_actor(actor,o.id,u.id,'account_invite',true)));
 ELSIF op='contacts' THEN
 SELECT jsonb_build_object('items',COALESCE(jsonb_agg(x),'[]'),'page',page) INTO result FROM (
 SELECT c.id,c.member_id AS "memberId",c.unit_id AS "unitId",u.name AS "unitName",l.display_name AS "displayName",
 left(c.email,2)||'…@example.invalid' AS "contactHint"
 FROM ertad.web_invite_contacts c JOIN ertad.units u ON (u.organization_id,u.id)=(c.organization_id,c.unit_id)
 JOIN ertad.member_users m ON m.id=c.member_id
 LEFT JOIN ertad.organization_member_labels l ON (l.organization_id,l.member_id)=(c.organization_id,c.member_id)
 WHERE c.organization_id=org AND ertad.collective_actor(actor,org,c.unit_id,'account_invite',false)
 AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp() AND m.status='active' AND m.web_account_id IS NULL
 AND NOT EXISTS(SELECT 1 FROM ertad.admin_users existing WHERE existing.email=c.email)
 AND EXISTS(SELECT 1 FROM ertad.memberships ms WHERE ms.organization_id=org AND ms.user_id=m.id AND ms.unit_id=c.unit_id AND ertad.member_membership_state(ms)='active')
 ORDER BY c.id LIMIT 25 OFFSET(page-1)*25) x;
 ELSIF op='list' THEN
 SELECT jsonb_build_object('items',COALESCE(jsonb_agg(x),'[]'),'page',page) INTO result FROM (
 SELECT p.id,p.unit_id AS "unitId",u.name AS "unitName",l.display_name AS "displayName",p.version,
 CASE WHEN i.consumed_at IS NOT NULL THEN 'activated' WHEN i.revoked_at IS NOT NULL THEN 'revoked'
 WHEN p.deadline<=clock_timestamp() OR c.expires_at<=clock_timestamp() OR (i.expires_at IS NOT NULL AND i.expires_at<=clock_timestamp()) THEN 'expired'
 WHEN p.status IN ('rejected','withdrawn') THEN p.status
 WHEN c.revoked_at IS NOT NULL OR m.status<>'active' OR m.web_account_id IS NOT NULL
 OR p.scope_path IS DISTINCT FROM ertad.unit_path(org,p.unit_id)
 OR NOT ertad.collective_actor(p.proposer_id,org,p.unit_id,'account_invite',false)
 OR NOT EXISTS(SELECT 1 FROM ertad.memberships ms WHERE ms.organization_id=org AND ms.user_id=m.id AND ms.unit_id=p.unit_id AND ertad.member_membership_state(ms)='active')
 OR (p.status='approved' AND ertad.collective_yes(p)<p.threshold) THEN 'unavailable'
 WHEN p.status='approved' AND i.token_hash IS NOT NULL THEN 'activation_pending'
 WHEN p.status='approved' THEN 'delivery_pending' ELSE p.status END AS status,
 LEAST(p.deadline,c.expires_at,i.expires_at) AS deadline,ertad.collective_actor(actor,org,p.unit_id,'account_invite',false) AND p.status='approved' AND i.consumed_at IS NULL AND i.revoked_at IS NULL AS "canRevoke"
 FROM ertad.collective_proposals p JOIN ertad.web_invite_contacts c ON c.organization_id=p.organization_id AND c.id=(p.parameters->>'contactId')::uuid
 JOIN ertad.member_users m ON m.id=c.member_id
 JOIN ertad.units u ON (u.organization_id,u.id)=(p.organization_id,p.unit_id)
 LEFT JOIN ertad.organization_member_labels l ON (l.organization_id,l.member_id)=(c.organization_id,c.member_id)
 LEFT JOIN ertad.web_invitations i ON i.id=p.id
 WHERE p.organization_id=org AND p.kind='account_invite' AND ertad.collective_visible(actor,p)
 ORDER BY p.created_at DESC,p.id LIMIT 25 OFFSET(page-1)*25) x;
 ELSE
 SELECT * INTO i FROM ertad.web_invitations WHERE organization_id=org AND id=(input->>'id')::uuid FOR UPDATE;
 SELECT * INTO p FROM ertad.collective_proposals WHERE organization_id=org AND id=i.id;
 IF p.id IS NULL OR NOT ertad.collective_actor(actor,org,p.unit_id,'account_invite',false) OR i.consumed_at IS NOT NULL THEN
 RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Revocation unavailable'; END IF;
 IF op='revoke_check' THEN
 IF i.revoked_at IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Revocation changed'; END IF;
 ELSE UPDATE ertad.web_invitations SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=i.id; END IF;
 result:=jsonb_build_object('id',i.id);
 END IF;
 RETURN jsonb_build_object('data',result,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op));
END $$;

-- Owner-only local delivery. Runtime and proposal authors never receive raw tokens.
CREATE FUNCTION ertad.web_invite_delivery(invite uuid,digest text) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE i ertad.web_invitations; c ertad.web_invite_contacts;
BEGIN
 SELECT * INTO i FROM ertad.web_invitations WHERE id=invite;
 PERFORM 1 FROM ertad.organizations WHERE id=i.organization_id FOR UPDATE;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint);
 SELECT * INTO i FROM ertad.web_invitations WHERE id=invite FOR UPDATE;
 IF i.id IS NULL OR i.consumed_at IS NOT NULL OR i.token_hash IS NOT NULL OR digest IS NULL OR digest !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Delivery unavailable'; END IF;
 c:=ertad.web_invite_live(i);
 UPDATE ertad.web_invitations SET token_hash=digest,delivered_at=clock_timestamp(),expires_at=LEAST(clock_timestamp()+interval '24 hours',c.expires_at,(SELECT deadline FROM ertad.collective_proposals WHERE organization_id=i.organization_id AND id=i.id)) WHERE id=i.id;
 RETURN jsonb_build_object('email',c.email,'id',i.id);
END $$;

CREATE FUNCTION ertad.web_invite_activate(invite uuid,digest text,password_hash text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i ertad.web_invitations; c ertad.web_invite_contacts; account uuid;
BEGIN
 SELECT * INTO i FROM ertad.web_invitations WHERE id=invite;
 PERFORM 1 FROM ertad.organizations WHERE id=i.organization_id AND status='active' FOR UPDATE;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint);
 SELECT * INTO i FROM ertad.web_invitations WHERE id=invite FOR UPDATE;
 IF i.id IS NULL OR i.token_hash IS DISTINCT FROM digest OR digest IS NULL OR i.expires_at<=clock_timestamp()
 OR i.delivered_at IS NULL OR i.consumed_at IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Activation unavailable'; END IF;
 c:=ertad.web_invite_live(i);
 IF password_hash IS NULL THEN RETURN jsonb_build_object('email',c.email); END IF;
 IF password_hash !~ '^\$2[aby]\$1[0-4]\$[./A-Za-z0-9]{53}$' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Password hash required'; END IF;
 INSERT INTO ertad.admin_users(email,password_hash,role) VALUES(c.email,password_hash,'observer') RETURNING id INTO account;
 UPDATE ertad.member_users SET web_account_id=account WHERE id=c.member_id AND web_account_id IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Member already linked'; END IF;
 UPDATE ertad.web_invitations SET consumed_at=clock_timestamp(),account_id=account WHERE id=invite;
 RETURN jsonb_build_object('accountId',account);
END $$;
CREATE FUNCTION ertad.web_invite_activation_finish(invite uuid,digest text,account uuid,password_hash text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i ertad.web_invitations;
BEGIN
 SELECT * INTO i FROM ertad.web_invitations WHERE id=invite;
 IF i.token_hash IS DISTINCT FROM digest OR i.account_id IS DISTINCT FROM account OR i.consumed_at IS NULL OR i.expires_at<=clock_timestamp()
 OR NOT EXISTS(SELECT 1 FROM ertad.admin_users a WHERE a.id=account AND a.password_hash=web_invite_activation_finish.password_hash AND a.is_active
 AND a.role='observer' AND NOT a.mfa_enabled AND a.mfa_secret_encrypted IS NULL
 AND (a.locked_until IS NULL OR a.locked_until<=clock_timestamp())) THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Activation changed'; END IF;
 PERFORM ertad.web_invite_live(i,account);
END $$;

REVOKE ALL ON FUNCTION ertad.freeze_invite_contact(),ertad.collective_before_invites_actor(uuid,uuid,uuid,text,boolean),
 ertad.collective_actor(uuid,uuid,uuid,text,boolean),ertad.collective_before_invites_visible(uuid,ertad.collective_proposals),
 ertad.collective_visible(uuid,ertad.collective_proposals),ertad.web_invite_validate(uuid,uuid,jsonb,uuid),
 ertad.collective_before_invites_apply(ertad.collective_proposals),ertad.collective_apply(ertad.collective_proposals),
 ertad.collective_before_invites_finish(uuid,text,text,uuid,jsonb,boolean),ertad.web_invite_live(ertad.web_invitations,uuid),
 ertad.web_invite_delivery(uuid,text) FROM PUBLIC,ertad_app;
REVOKE ALL ON FUNCTION ertad.collective_finish(uuid,text,text,uuid,jsonb,boolean),ertad.web_invite_command(uuid,text,text,uuid,jsonb),
 ertad.web_invite_activate(uuid,text,text),ertad.web_invite_activation_finish(uuid,text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.collective_finish(uuid,text,text,uuid,jsonb,boolean),ertad.web_invite_command(uuid,text,text,uuid,jsonb),
 ertad.web_invite_activate(uuid,text,text),ertad.web_invite_activation_finish(uuid,text,uuid,text) TO ertad_app;
