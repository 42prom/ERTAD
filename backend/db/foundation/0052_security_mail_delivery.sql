-- Reviewed member/contact association, recipient proof and durable security-mail delivery.
ALTER TABLE ertad.web_invite_contacts DROP CONSTRAINT web_invite_contacts_email_check;
ALTER TABLE ertad.web_invite_contacts DROP CONSTRAINT web_invite_contacts_source_check;
ALTER TABLE ertad.web_invite_contacts ADD COLUMN verified_at timestamptz,
 ADD COLUMN creator_id uuid REFERENCES ertad.member_users(id), ADD COLUMN request_key uuid,
 ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 ADD UNIQUE(creator_id,request_key),
 ADD CHECK(source IN ('synthetic','email')),
 ADD CHECK(email=lower(trim(email)) AND length(email)<=254 AND email ~ '^[a-z0-9._%+-]+@[a-z0-9.-]+[.][a-z]{2,}$'),
 ADD CHECK(source<>'synthetic' OR email ~ '^[a-z0-9._+-]+@example[.]invalid$');
CREATE OR REPLACE FUNCTION ertad.freeze_invite_contact() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF to_jsonb(NEW)-ARRAY['revoked_at','verified_at'] IS DISTINCT FROM to_jsonb(OLD)-ARRAY['revoked_at','verified_at']
 OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
 OR (OLD.verified_at IS NOT NULL AND NEW.verified_at IS DISTINCT FROM OLD.verified_at) THEN
 RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Contact bindings are immutable'; END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION ertad.web_contact_command(sid uuid,token text,op text,org uuid,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid; target uuid:=(input->>'unitId')::uuid; member uuid:=(input->>'memberId')::uuid;
 c ertad.web_invite_contacts; result jsonb; page integer:=COALESCE((input->>'page')::integer,1);
BEGIN
 IF op NOT IN ('candidates','create') OR page NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid contact operation'; END IF;
 actor:=ertad.review_identity(sid,token,op='create');
 PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint);
 PERFORM ertad.review_identity(sid,token,op='create');
 IF op='candidates' THEN
 SELECT jsonb_build_object('items',COALESCE(jsonb_agg(x),'[]'),'page',page) INTO result FROM (
 SELECT DISTINCT m.id AS "memberId",u.id AS "unitId",u.name AS "unitName",l.display_name AS "displayName"
 FROM ertad.member_users m JOIN ertad.memberships ms ON ms.user_id=m.id AND ms.organization_id=org
 JOIN ertad.units u ON (u.organization_id,u.id)=(ms.organization_id,ms.unit_id)
 LEFT JOIN ertad.organization_member_labels l ON l.organization_id=org AND l.member_id=m.id
 WHERE m.status='active' AND m.web_account_id IS NULL AND m.id<>actor AND ertad.member_membership_state(ms)='active'
 AND ertad.collective_actor(actor,org,u.id,'account_invite',false)
 ORDER BY u.id,m.id LIMIT 25 OFFSET (page-1)*25) x;
 ELSE
 IF NOT ertad.collective_actor(actor,org,target,'account_invite',false) OR member=actor THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 IF input->>'requestId' IS NULL OR input->>'email' IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Contact required'; END IF;
 SELECT * INTO c FROM ertad.web_invite_contacts WHERE creator_id=actor AND request_key=(input->>'requestId')::uuid;
 IF FOUND THEN
 IF (c.organization_id,c.unit_id,c.member_id,c.email) IS DISTINCT FROM (org,target,member,input->>'email') OR c.revoked_at IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Contact request changed'; END IF;
 ELSE
 IF (SELECT count(*) FROM ertad.web_invite_contacts WHERE creator_id=actor AND created_at>clock_timestamp()-interval '1 hour')>=10
 OR EXISTS(SELECT 1 FROM ertad.web_invite_contacts WHERE organization_id=org AND member_id=member AND source='email' AND revoked_at IS NULL AND expires_at>clock_timestamp()) THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Contact creation unavailable'; END IF;
 INSERT INTO ertad.web_invite_contacts(organization_id,unit_id,member_id,email,source,expires_at,creator_id,request_key)
 VALUES(org,target,member,input->>'email','email',clock_timestamp()+interval '365 days',actor,(input->>'requestId')::uuid) RETURNING * INTO c;
 END IF;
 PERFORM ertad.web_invite_validate(org,target,jsonb_build_object('contactId',c.id));
 result:=jsonb_build_object('id',c.id);
 END IF;
 RETURN jsonb_build_object('data',result,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op));
END $$;
REVOKE ALL ON FUNCTION ertad.web_contact_command(uuid,text,text,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.web_contact_command(uuid,text,text,uuid,jsonb) TO ertad_app;

CREATE TABLE ertad.security_mail_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), purpose text NOT NULL CHECK(purpose IN ('contact','invitation','recovery')),
 source_id uuid NOT NULL, token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 token_cipher text CHECK(token_cipher IS NULL OR (token_cipher LIKE 'v2:%' AND length(token_cipher) BETWEEN 60 AND 1200)),
 policy_version integer NOT NULL CHECK(policy_version>0), expires_at timestamptz NOT NULL CHECK(isfinite(expires_at)),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sending','retry','accepted','failed','uncertain','cancelled')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5), next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease_id uuid, lease_until timestamptz, consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(purpose,source_id)
);
CREATE INDEX security_mail_pending ON ertad.security_mail_jobs(next_attempt_at,id) WHERE state IN ('queued','retry');
REVOKE ALL ON ertad.security_mail_jobs FROM PUBLIC,ertad_app;

-- Runtime source lookup is internal to the narrow queue functions, never an HTTP projection.
CREATE FUNCTION ertad.security_mail_source(kind text,source uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE i ertad.web_invitations; c ertad.web_invite_contacts; r ertad.web_account_recoveries;
BEGIN
 IF kind='recovery' THEN
 r:=ertad.web_recovery_live(source);
 SELECT * INTO c FROM ertad.web_invite_contacts WHERE organization_id=r.organization_id AND id=r.contact_id;
 IF c.source<>'email' OR c.verified_at IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Contact proof required'; END IF;
 RETURN jsonb_build_object('email',c.email,'expiresAt',r.expires_at,'hash',r.token_hash);
 END IF;
 IF kind NOT IN ('contact','invitation') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid message purpose'; END IF;
 SELECT * INTO i FROM ertad.web_invitations WHERE id=source;
 PERFORM 1 FROM ertad.organizations WHERE id=i.organization_id AND status='active' FOR UPDATE;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint);
 SELECT * INTO i FROM ertad.web_invitations WHERE id=source FOR UPDATE;
 c:=ertad.web_invite_live(i);
 IF i.consumed_at IS NOT NULL OR c.source<>'email' OR (kind='invitation' AND c.verified_at IS NULL) THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Mail unavailable'; END IF;
 RETURN jsonb_build_object('email',c.email,'expiresAt',LEAST(c.expires_at,(SELECT deadline FROM ertad.collective_proposals WHERE id=i.id),COALESCE(i.expires_at,clock_timestamp()+interval '24 hours')),'hash',i.token_hash,'verified',c.verified_at IS NOT NULL);
END $$;

CREATE FUNCTION ertad.security_mail_candidates() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE(jsonb_agg(x),'[]') FROM (
 SELECT CASE WHEN c.verified_at IS NULL THEN 'contact' ELSE 'invitation' END AS purpose,i.id
 FROM ertad.web_invitations i JOIN ertad.web_invite_contacts c ON (c.organization_id,c.id)=(i.organization_id,i.contact_id)
 JOIN ertad.collective_proposals p ON p.id=i.id
 WHERE c.source='email' AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp() AND i.revoked_at IS NULL AND i.consumed_at IS NULL
 AND i.token_hash IS NULL AND p.status='approved' AND p.deadline>clock_timestamp() AND p.scope_path=ertad.unit_path(p.organization_id,p.unit_id)
 AND ertad.collective_actor(p.proposer_id,p.organization_id,p.unit_id,'account_invite',false) AND ertad.collective_yes(p)>=p.threshold
 AND NOT EXISTS(SELECT 1 FROM ertad.security_mail_jobs j WHERE j.source_id=i.id AND j.purpose=CASE WHEN c.verified_at IS NULL THEN 'contact' ELSE 'invitation' END)
 UNION ALL
 SELECT 'recovery',r.id FROM ertad.web_account_recoveries r JOIN ertad.web_invite_contacts c ON (c.organization_id,c.id)=(r.organization_id,r.contact_id)
 WHERE c.source='email' AND r.token_hash IS NULL AND r.revoked_at IS NULL AND r.consumed_at IS NULL AND r.expires_at>clock_timestamp()
 AND ertad.web_recovery_eligible(r.account_id,r.organization_id,r.contact_id)
 AND NOT EXISTS(SELECT 1 FROM ertad.security_mail_jobs j WHERE j.source_id=r.id AND j.purpose='recovery')
 LIMIT 20) x
$$;
CREATE FUNCTION ertad.security_mail_prepare(kind text,source uuid,digest text,cipher text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE data jsonb; policy jsonb; job uuid; expiry timestamptz;
BEGIN
 data:=ertad.security_mail_source(kind,source);
 policy:=ertad.current_mail_policy();
 IF policy->>'deliveryEnabled'<>'true' OR policy->>'mode'<>'enabled' THEN RETURN NULL; END IF;
 SELECT id INTO job FROM ertad.security_mail_jobs WHERE purpose=kind AND source_id=source;
 IF FOUND THEN RETURN job; END IF;
 IF digest IS NULL OR digest !~ '^[a-f0-9]{64}$' OR cipher IS NULL OR cipher NOT LIKE 'v2:%' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Token required'; END IF;
 expiry:=(data->>'expiresAt')::timestamptz;
 IF kind='contact' THEN
 IF data->>'verified'='true' THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Contact already proved'; END IF;
 expiry:=LEAST(expiry,clock_timestamp()+interval '30 minutes');
 ELSIF kind='invitation' THEN PERFORM ertad.web_invite_delivery(source,digest);
 ELSE PERFORM ertad.web_recovery_delivery(source,digest); END IF;
 INSERT INTO ertad.security_mail_jobs(purpose,source_id,token_hash,token_cipher,policy_version,expires_at)
 VALUES(kind,source,digest,cipher,(policy->>'version')::integer,expiry) RETURNING id INTO job;
 RETURN job;
END $$;
CREATE FUNCTION ertad.security_mail_claim(job_id uuid,lease uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j ertad.security_mail_jobs; data jsonb; policy jsonb;
BEGIN
 -- Lock source authority first, matching activation/recovery's lock order.
 SELECT * INTO j FROM ertad.security_mail_jobs WHERE id=job_id;
 IF j.id IS NULL THEN RETURN NULL; END IF;
 BEGIN data:=ertad.security_mail_source(j.purpose,j.source_id);
 EXCEPTION WHEN SQLSTATE 'P0409' OR SQLSTATE '42501' THEN
 IF j.state='sending' AND j.lease_id=lease THEN RAISE; END IF;
 UPDATE ertad.security_mail_jobs SET state='cancelled',token_cipher=NULL,updated_at=clock_timestamp() WHERE id=job_id AND state IN ('queued','retry'); RETURN NULL; END;
 SELECT * INTO j FROM ertad.security_mail_jobs WHERE id=job_id FOR UPDATE;
 policy:=ertad.current_mail_policy();
 IF j.lease_id=lease AND j.state='sending' AND j.lease_until>clock_timestamp() THEN
 IF j.expires_at<=clock_timestamp() OR j.policy_version<>(policy->>'version')::integer OR policy->>'deliveryEnabled'<>'true' OR policy->>'mode'<>'enabled' THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Mail authority changed'; END IF;
 ELSE
 IF j.state NOT IN ('queued','retry') OR j.next_attempt_at>clock_timestamp() THEN RETURN NULL; END IF;
 IF j.expires_at<=clock_timestamp() OR j.attempts>=5 THEN
 UPDATE ertad.security_mail_jobs SET state='cancelled',token_cipher=NULL,updated_at=clock_timestamp() WHERE id=job_id; RETURN NULL; END IF;
 IF policy->>'deliveryEnabled'<>'true' OR policy->>'mode'<>'enabled' THEN RETURN NULL; END IF;
 UPDATE ertad.security_mail_jobs SET state='sending',policy_version=(policy->>'version')::integer,attempts=attempts+1,lease_id=lease,lease_until=clock_timestamp()+interval '1 minute',updated_at=clock_timestamp() WHERE id=job_id RETURNING * INTO j;
 END IF;
 RETURN jsonb_build_object('email',data->>'email','id',j.source_id,'purpose',j.purpose,'tokenCipher',j.token_cipher,'tokenHash',j.token_hash,'policy',policy);
END $$;
CREATE FUNCTION ertad.security_mail_pending() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 UPDATE ertad.security_mail_jobs SET state='uncertain',token_cipher=NULL,updated_at=clock_timestamp() WHERE state='sending' AND lease_until<=clock_timestamp();
 UPDATE ertad.security_mail_jobs SET state='cancelled',token_cipher=NULL,updated_at=clock_timestamp() WHERE state IN ('queued','retry') AND expires_at<=clock_timestamp();
 RETURN (SELECT COALESCE(jsonb_agg(id),'[]') FROM (SELECT id FROM ertad.security_mail_jobs WHERE state IN ('queued','retry') AND next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at,id LIMIT 20) x);
END $$;
CREATE FUNCTION ertad.security_mail_finish(job_id uuid,lease uuid,outcome text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(752991884322001::bigint);
 IF outcome NOT IN ('accepted','retry','failed','uncertain') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid delivery outcome'; END IF;
 UPDATE ertad.security_mail_jobs SET state=CASE WHEN outcome='retry' AND attempts>=5 THEN 'failed' ELSE outcome END,
 token_cipher=CASE WHEN outcome='retry' AND attempts<5 THEN token_cipher ELSE NULL END,
 next_attempt_at=clock_timestamp()+make_interval(secs=>LEAST(3600,60*power(2,attempts)::integer)),updated_at=clock_timestamp()
 WHERE id=job_id AND lease_id=lease AND state='sending';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Delivery outcome unavailable'; END IF;
END $$;
CREATE FUNCTION ertad.web_contact_confirm(invite uuid,digest text,checking boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j ertad.security_mail_jobs; i ertad.web_invitations; data jsonb;
BEGIN
 data:=ertad.security_mail_source('contact',invite);
 SELECT * INTO j FROM ertad.security_mail_jobs WHERE purpose='contact' AND source_id=invite FOR UPDATE;
 IF j.id IS NULL OR digest IS NULL OR j.token_hash IS DISTINCT FROM digest OR j.expires_at<=clock_timestamp()
 OR j.state IN ('failed','cancelled') OR (NOT checking AND j.consumed_at IS NOT NULL) OR (checking AND j.consumed_at IS NULL) THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Contact confirmation unavailable'; END IF;
 SELECT * INTO i FROM ertad.web_invitations WHERE id=invite;
 IF checking THEN
 IF NOT EXISTS(SELECT 1 FROM ertad.web_invite_contacts WHERE organization_id=i.organization_id AND id=i.contact_id AND verified_at IS NOT NULL) THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Contact changed during audit'; END IF;
 ELSE
 UPDATE ertad.web_invite_contacts SET verified_at=COALESCE(verified_at,clock_timestamp()) WHERE organization_id=i.organization_id AND id=i.contact_id;
 UPDATE ertad.security_mail_jobs SET consumed_at=clock_timestamp() WHERE id=j.id;
 END IF;
END $$;

-- Keep source transport isolation and require proof at the activation boundary.
DO $$ DECLARE body text; old text; BEGIN
 SELECT pg_get_functiondef('ertad.web_invite_activate(uuid,text,text)'::regprocedure) INTO body; old:=body;
 body:=replace(body,'c:=ertad.web_invite_live(i);','c:=ertad.web_invite_live(i); IF c.source=''email'' AND c.verified_at IS NULL THEN RAISE EXCEPTION USING ERRCODE=''P0409'',MESSAGE=''Contact proof required''; END IF;');
 IF body=old THEN RAISE EXCEPTION 'Activation extension point changed'; END IF; EXECUTE body;
 SELECT pg_get_functiondef('ertad.web_recovery_eligible(uuid,uuid,uuid)'::regprocedure) INTO body; old:=body;
 body:=replace(body,'c.source=''synthetic''','(c.source=''synthetic'' OR (c.source=''email'' AND c.verified_at IS NOT NULL))');
 IF body=old THEN RAISE EXCEPTION 'Recovery extension point changed'; END IF; EXECUTE body;
 SELECT pg_get_functiondef('ertad.web_invite_command(uuid,text,text,uuid,jsonb)'::regprocedure) INTO body;
 body:=replace(body,'''…@example.invalid''','''…@…''');
 old:=body;
 body:=replace(body,'SELECT p.id,p.unit_id AS "unitId"', 'SELECT p.id,(c.source=''email'' AND c.verified_at IS NULL) AS "needsEmailProof",(SELECT state FROM ertad.security_mail_jobs j WHERE j.source_id=i.id AND j.purpose=CASE WHEN c.verified_at IS NULL THEN ''contact'' ELSE ''invitation'' END) AS "mailStatus",p.unit_id AS "unitId"');
 IF body=old THEN RAISE EXCEPTION 'Invitation delivery view extension point changed'; END IF; EXECUTE body;
 SELECT pg_get_functiondef('ertad.collective_view(uuid,ertad.collective_proposals)'::regprocedure) INTO body;
 body:=replace(body,'''…@example.invalid''','''…@…'''); EXECUTE body;
 SELECT pg_get_functiondef('ertad.mail_policy_command(uuid,text,text,jsonb)'::regprocedure) INTO body; old:=body;
 body:=replace(body,'''items'',COALESCE((SELECT jsonb_agg','''delivery'',COALESCE((SELECT jsonb_object_agg(state,n) FROM (SELECT state,count(*) n FROM ertad.security_mail_jobs GROUP BY state) counts),''{}''::jsonb),''items'',COALESCE((SELECT jsonb_agg');
 IF body=old THEN RAISE EXCEPTION 'Mail diagnostics extension point changed'; END IF; EXECUTE body;
END $$;
CREATE FUNCTION ertad.security_mail_finish_check(job_id uuid,lease uuid,outcome text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM ertad.security_mail_jobs WHERE id=job_id AND lease_id=lease
 AND state=CASE WHEN outcome='retry' AND attempts>=5 THEN 'failed' ELSE outcome END
 AND (state='retry' OR token_cipher IS NULL)) THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Delivery result changed during audit'; END IF;
END $$;
REVOKE ALL ON FUNCTION ertad.security_mail_finish_check(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.security_mail_finish_check(uuid,uuid,text) TO ertad_app;
REVOKE ALL ON FUNCTION ertad.security_mail_source(text,uuid) FROM PUBLIC,ertad_app;
REVOKE ALL ON FUNCTION ertad.security_mail_candidates(),ertad.security_mail_prepare(text,uuid,text,text),ertad.security_mail_claim(uuid,uuid),ertad.security_mail_pending(),ertad.security_mail_finish(uuid,uuid,text),ertad.web_contact_confirm(uuid,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.security_mail_candidates(),ertad.security_mail_prepare(text,uuid,text,text),ertad.security_mail_claim(uuid,uuid),ertad.security_mail_pending(),ertad.security_mail_finish(uuid,uuid,text),ertad.web_contact_confirm(uuid,text,boolean) TO ertad_app;
