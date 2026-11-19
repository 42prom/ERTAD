-- Extend the existing reviewed appointment journey; never delete member history.
ALTER TABLE ertad.memberships ADD COLUMN version integer NOT NULL DEFAULT 0 CHECK(version>=0);
CREATE FUNCTION ertad.membership_version() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 NEW.version:=OLD.version;
 IF (to_jsonb(NEW)-'version') IS DISTINCT FROM (to_jsonb(OLD)-'version') THEN NEW.version:=OLD.version+1; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER c_membership_version BEFORE UPDATE ON ertad.memberships FOR EACH ROW EXECUTE FUNCTION ertad.membership_version();
ALTER TABLE ertad.membership_reviews ADD COLUMN kind text NOT NULL DEFAULT 'grant' CHECK(kind IN ('grant','transfer','revoke'));
ALTER TABLE ertad.membership_reviews ADD COLUMN source_id uuid;
ALTER TABLE ertad.membership_reviews ADD COLUMN source_snapshot jsonb;
ALTER TABLE ertad.membership_reviews ADD COLUMN source_path uuid[];
ALTER TABLE ertad.membership_reviews ADD COLUMN destination_path uuid[];
ALTER TABLE ertad.membership_reviews ADD FOREIGN KEY(organization_id,source_id) REFERENCES ertad.memberships(organization_id,id);
ALTER TABLE ertad.membership_reviews ADD CHECK(
 (kind='grant' AND source_id IS NULL AND source_snapshot IS NULL AND source_path IS NULL AND destination_path IS NULL)
 OR (kind<>'grant' AND source_id IS NOT NULL AND source_snapshot IS NOT NULL AND jsonb_typeof(source_snapshot)='object'
 AND source_path IS NOT NULL AND cardinality(source_path)>0 AND destination_path IS NOT NULL AND cardinality(destination_path)>0));
ALTER TABLE ertad.membership_reviews ALTER COLUMN valid_until DROP NOT NULL;
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='ertad.membership_reviews'::regclass AND contype='c'
 AND pg_get_constraintdef(oid) LIKE '%valid_until%' LOOP
 EXECUTE format('ALTER TABLE ertad.membership_reviews DROP CONSTRAINT %I',c.conname);
 END LOOP;
END; $$;
ALTER TABLE ertad.membership_reviews ADD CHECK((kind='revoke' AND valid_until IS NULL) OR
 (kind IN ('grant','transfer') AND valid_until IS NOT NULL AND isfinite(valid_until) AND valid_until>expires_at AND valid_until<=created_at+interval '366 days'));
CREATE INDEX membership_reviews_source ON ertad.membership_reviews(organization_id,source_id,status);

CREATE FUNCTION ertad.membership_change_scope(actor uuid,r ertad.membership_reviews,permission text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT ertad.review_has_scope(actor,r.organization_id,r.unit_id,permission)
 AND (r.kind='grant' OR (ertad.review_has_scope(actor,r.organization_id,(r.source_snapshot->>'unit_id')::uuid,permission)
 AND ertad.member_unit_visible(actor,r.organization_id,(r.source_snapshot->>'unit_id')::uuid)
 AND ertad.member_unit_visible(actor,r.organization_id,r.unit_id)))
$$;
CREATE OR REPLACE FUNCTION ertad.review_visible(member uuid,r ertad.membership_reviews) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT (r.requester_id=member AND ertad.membership_change_scope(member,r,'membership.propose'))
 OR (member NOT IN(r.requester_id,r.target_id) AND ertad.membership_change_scope(member,r,'membership.approve'))
 OR (r.target_id=member AND r.status<>'pending' AND ertad.review_has_scope(member,r.organization_id,r.unit_id,'unit.read')
 AND (r.kind='grant' OR ertad.review_has_scope(member,r.organization_id,(r.source_snapshot->>'unit_id')::uuid,'unit.read')))
$$;
CREATE FUNCTION ertad.membership_change_blocked(org uuid,subject uuid,source_unit uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM ertad.work_assignments a JOIN ertad.work_items w ON w.organization_id=a.organization_id AND w.id=a.work_id
 WHERE a.organization_id=org AND a.user_id=subject AND a.status IN ('applied','reserved','assigned','in_progress','submitted')
 AND source_unit=ANY(ertad.unit_path(org,w.unit_id)))
$$;
CREATE FUNCTION ertad.membership_change_assert(r ertad.membership_reviews) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE m ertad.memberships; p ertad.positions; expected jsonb;
BEGIN
 SELECT * INTO m FROM ertad.memberships WHERE organization_id=r.organization_id AND id=r.source_id;
 expected:=r.source_snapshot;
 IF r.status='approved' THEN expected:=expected||jsonb_build_object('status','ended','version',(expected->>'version')::integer+1); END IF;
 IF NOT FOUND OR to_jsonb(m) IS DISTINCT FROM expected
 OR r.source_path IS DISTINCT FROM ertad.unit_path(r.organization_id,m.unit_id)
 OR r.destination_path IS DISTINCT FROM ertad.unit_path(r.organization_id,r.unit_id)
 OR m.valid_from>clock_timestamp() OR m.valid_until<=clock_timestamp()
 OR NOT EXISTS(SELECT 1 FROM ertad.member_users WHERE id=r.target_id AND status='active') THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Membership changed'; END IF;
 IF r.status IN ('pending','approved') AND ertad.membership_change_blocked(r.organization_id,r.target_id,m.unit_id) THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Active responsibilities'; END IF;
 IF r.kind='transfer' THEN
 SELECT * INTO p FROM ertad.positions WHERE organization_id=r.organization_id AND id=r.position_id;
 IF NOT FOUND OR p.status<>'active' OR (p.unit_id,p.bundle_id,p.bundle_version) IS DISTINCT FROM (r.unit_id,r.bundle_id,r.bundle_version)
 OR NOT EXISTS(SELECT 1 FROM ertad.permission_bundles WHERE organization_id=r.organization_id AND id=r.bundle_id AND version=r.bundle_version AND status='approved')
 OR r.valid_until<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Destination changed'; END IF;
 IF EXISTS(SELECT 1 FROM ertad.memberships WHERE organization_id=r.organization_id AND user_id=r.target_id AND position_id=r.position_id
 AND id IS DISTINCT FROM r.membership_id AND status='active' AND (valid_until IS NULL OR valid_until>clock_timestamp())) THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Destination membership exists'; END IF;
 IF r.status='approved' AND NOT EXISTS(SELECT 1 FROM ertad.memberships n WHERE n.organization_id=r.organization_id AND n.id=r.membership_id
 AND n.user_id=r.target_id AND n.position_id=r.position_id AND n.unit_id=r.unit_id AND n.bundle_version=r.bundle_version
 AND n.status='active' AND n.version=0 AND n.valid_from<=clock_timestamp() AND n.valid_until=r.valid_until) THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Destination changed'; END IF;
 END IF;
END; $$;

-- Keep the established grant/read implementation private behind the expanded command.
ALTER FUNCTION ertad.membership_review_command(uuid,text,text,uuid,jsonb) RENAME TO membership_grant_command;
REVOKE ALL ON FUNCTION ertad.membership_grant_command(uuid,text,text,uuid,jsonb) FROM PUBLIC,ertad_app;
CREATE FUNCTION ertad.membership_review_command(sid uuid,token text,op text,org uuid,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_column
DECLARE actor uuid; r ertad.membership_reviews; m ertad.memberships; p ertad.positions; result jsonb; envelope jsonb;
 change_kind text:=input->>'kind'; expiry timestamptz; until_at timestamptz; key uuid; decision text; changed boolean:=false; mid uuid;
BEGIN
 IF op='contexts' THEN RETURN ertad.membership_grant_command(sid,token,op,org,input); END IF;
 actor:=ertad.review_identity(sid,token,op IN ('change','propose','decide'));
 IF op IN ('change','propose','decide') THEN
 PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR UPDATE;
 ELSE
 IF org IS NOT NULL THEN PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR SHARE; END IF;
 END IF;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint);
 PERFORM ertad.review_identity(sid,token,op IN ('change','propose','decide'));
 IF op='decide' THEN SELECT * INTO r FROM ertad.membership_reviews WHERE organization_id=org AND id=(input->>'id')::uuid; END IF;
 IF op IN ('change','changeOptions') THEN
 SELECT * INTO m FROM ertad.memberships WHERE organization_id=org AND id=(input->>'membershipId')::uuid;
 IF NOT FOUND OR actor=m.user_id OR NOT ertad.member_unit_visible(actor,org,m.unit_id)
 OR NOT ertad.review_has_scope(actor,org,m.unit_id,'membership.propose') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 IF op='changeOptions' THEN
 result:=jsonb_build_object('id',m.id,'version',m.version,'active',m.status='active' AND m.valid_from<=clock_timestamp() AND (m.valid_until IS NULL OR m.valid_until>clock_timestamp()),
 'validUntil',m.valid_until,'unitName',(SELECT name FROM ertad.units WHERE organization_id=org AND id=m.unit_id),
 'positionName',(SELECT name FROM ertad.positions WHERE organization_id=org AND id=m.position_id),
 'blocked',ertad.membership_change_blocked(org,m.user_id,m.unit_id),
 'destinations',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'unitName',u.name) ORDER BY u.name,p.name,p.id),'[]')
 FROM ertad.positions p JOIN ertad.units u ON u.organization_id=p.organization_id AND u.id=p.unit_id
 JOIN ertad.permission_bundles b ON b.organization_id=p.organization_id AND b.id=p.bundle_id AND b.version=p.bundle_version
 WHERE p.organization_id=org AND p.id<>m.position_id AND p.status='active' AND b.status='approved'
 AND ertad.member_unit_visible(actor,org,p.unit_id) AND ertad.review_has_scope(actor,org,p.unit_id,'membership.propose')));
 ELSE
 IF change_kind NOT IN ('transfer','revoke') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid change'; END IF;
 key:=(input->>'key')::uuid; expiry:=(input->>'expiresAt')::timestamptz; until_at:=(input->>'validUntil')::timestamptz;
 SELECT * INTO p FROM ertad.positions WHERE organization_id=org AND id=CASE WHEN change_kind='revoke' THEN m.position_id ELSE (input->>'positionId')::uuid END;
 IF NOT FOUND OR NOT ertad.member_unit_visible(actor,org,p.unit_id) OR NOT ertad.review_has_scope(actor,org,p.unit_id,'membership.propose') THEN
 RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 SELECT * INTO r FROM ertad.membership_reviews WHERE organization_id=org AND requester_id=actor AND request_key=key;
 IF FOUND THEN
 IF (r.kind,r.source_id,(r.source_snapshot->>'version')::integer,r.position_id,r.reason,r.expires_at,r.valid_until)
 IS DISTINCT FROM (change_kind,m.id,(input->>'version')::integer,p.id,input->>'reason',expiry,until_at) THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request conflict'; END IF;
 ELSE
 IF m.status<>'active' OR m.version IS DISTINCT FROM (input->>'version')::integer OR m.valid_from>clock_timestamp() OR m.valid_until<=clock_timestamp()
 OR expiry<=clock_timestamp() OR expiry>clock_timestamp()+interval '7 days'
 OR (change_kind='transfer' AND (p.id=m.position_id OR until_at IS NULL OR until_at<=expiry OR until_at>clock_timestamp()+interval '365 days' OR until_at>m.valid_until))
 OR (change_kind='revoke' AND (until_at IS NOT NULL OR input ? 'positionId')) THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request conflict'; END IF;
 INSERT INTO ertad.membership_reviews(organization_id,requester_id,target_id,unit_id,position_id,bundle_id,bundle_version,reason,valid_until,expires_at,request_key,
 kind,source_id,source_snapshot,source_path,destination_path)
 VALUES(org,actor,m.user_id,p.unit_id,p.id,p.bundle_id,p.bundle_version,input->>'reason',until_at,expiry,key,change_kind,m.id,to_jsonb(m),ertad.unit_path(org,m.unit_id),ertad.unit_path(org,p.unit_id)) RETURNING * INTO r;
 PERFORM ertad.membership_change_assert(r); changed:=true;
 END IF;
 result:=jsonb_build_object('id',r.id,'status',r.status);
 END IF;
 ELSIF op='decide' AND r.kind<>'grant' THEN
 IF actor IN(r.requester_id,r.target_id) OR NOT ertad.membership_change_scope(actor,r,'membership.approve') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 decision:=input->>'decision'; key:=(input->>'key')::uuid;
 IF decision NOT IN ('approved','rejected') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid decision'; END IF;
 IF r.status<>'pending' THEN
 IF (r.status,r.decision_by,r.decision_key,r.decision_reason) IS DISTINCT FROM (decision,actor,key,input->>'reason') THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request conflict'; END IF;
 ELSE
 IF r.expires_at<=clock_timestamp() OR NOT ertad.membership_change_scope(r.requester_id,r,'membership.propose') THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request conflict'; END IF;
 IF decision='approved' THEN
 PERFORM ertad.membership_change_assert(r);
 UPDATE ertad.memberships SET status='ended' WHERE organization_id=org AND id=r.source_id;
 mid:=r.source_id;
 IF r.kind='transfer' THEN
 INSERT INTO ertad.memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until)
 VALUES(org,r.target_id,r.unit_id,r.position_id,r.bundle_version,clock_timestamp(),r.valid_until) RETURNING id INTO mid;
 END IF;
 END IF;
 UPDATE ertad.membership_reviews SET status=decision,decision_by=actor,decision_key=key,decision_reason=input->>'reason',decision_at=clock_timestamp(),membership_id=mid
 WHERE organization_id=org AND id=r.id RETURNING * INTO r;
 INSERT INTO ertad.review_notifications(organization_id,review_id,recipient_id) VALUES(org,r.id,r.requester_id),(org,r.id,r.target_id);
 changed:=true;
 END IF;
 result:=jsonb_build_object('id',r.id,'status',r.status);
 ELSE
 IF op='propose' AND EXISTS(SELECT 1 FROM ertad.membership_reviews WHERE organization_id=org AND requester_id=actor AND request_key=(input->>'key')::uuid AND kind<>'grant') THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request conflict'; END IF;
 envelope:=ertad.membership_grant_command(sid,token,op,org,input);
 IF op='detail' THEN
 SELECT * INTO r FROM ertad.membership_reviews WHERE organization_id=org AND id=(input->>'id')::uuid;
 envelope:=jsonb_set(envelope,'{data}',((envelope->'data')-ARRAY['source_snapshot','source_path','destination_path'])||jsonb_build_object(
 'sourceUnitName',(SELECT name FROM ertad.units WHERE organization_id=org AND id=(r.source_snapshot->>'unit_id')::uuid),
 'sourcePositionName',(SELECT name FROM ertad.positions WHERE organization_id=org AND id=(r.source_snapshot->>'position_id')::uuid),
 'canDecide',r.status='pending' AND r.expires_at>clock_timestamp() AND actor NOT IN(r.requester_id,r.target_id) AND ertad.membership_change_scope(actor,r,'membership.approve')));
 ELSIF op='list' THEN
 envelope:=jsonb_set(envelope,'{data,items}',COALESCE((SELECT jsonb_agg(x||jsonb_build_object('kind',r.kind) ORDER BY ord)
 FROM jsonb_array_elements(envelope#>'{data,items}') WITH ORDINALITY a(x,ord)
 JOIN ertad.membership_reviews r ON r.organization_id=org AND r.id=(x->>'id')::uuid),'[]'));
 END IF;
 RETURN envelope;
 END IF;
 RETURN jsonb_build_object('data',result,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'reviewId',r.id,'changed',changed));
END; $$;

ALTER FUNCTION ertad.review_finish(uuid,text,uuid,uuid) RENAME TO membership_grant_finish;
REVOKE ALL ON FUNCTION ertad.membership_grant_finish(uuid,text,uuid,uuid) FROM PUBLIC,ertad_app;
CREATE FUNCTION ertad.review_finish(sid uuid,token text,org uuid,rid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid; r ertad.membership_reviews;
BEGIN
 actor:=ertad.review_identity(sid,token,true);
 SELECT * INTO r FROM ertad.membership_reviews WHERE organization_id=org AND id=rid;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 IF r.kind='grant' THEN PERFORM ertad.membership_grant_finish(sid,token,org,rid); RETURN; END IF;
 IF r.expires_at<=clock_timestamp() OR NOT ertad.membership_change_scope(r.requester_id,r,'membership.propose')
 OR NOT ((r.status='pending' AND r.requester_id=actor) OR (r.status<>'pending' AND r.decision_by=actor AND actor<>r.target_id
 AND ertad.membership_change_scope(actor,r,'membership.approve'))) THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request conflict'; END IF;
 -- Rejection changes no membership and remains possible after target/dependency drift.
 IF r.status<>'rejected' THEN PERFORM ertad.membership_change_assert(r); END IF;
END; $$;
REVOKE ALL ON FUNCTION ertad.membership_version(),ertad.membership_change_scope(uuid,ertad.membership_reviews,text),
 ertad.membership_change_blocked(uuid,uuid,uuid),ertad.membership_change_assert(ertad.membership_reviews),
 ertad.membership_review_command(uuid,text,text,uuid,jsonb),ertad.review_finish(uuid,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.membership_review_command(uuid,text,text,uuid,jsonb),ertad.review_finish(uuid,text,uuid,uuid) TO ertad_app;

CREATE OR REPLACE FUNCTION ertad.member_summary(actor uuid,org uuid,member uuid,target uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',member,'displayName',(SELECT display_name FROM ertad.organization_member_labels WHERE organization_id=org AND member_id=member),
 'memberships',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',m.id,'unitId',m.unit_id,'unitName',u.name,'positionId',m.position_id,'positionName',p.name,
 'canChange',m.user_id<>actor AND m.status='active' AND m.valid_from<=clock_timestamp() AND (m.valid_until IS NULL OR m.valid_until>clock_timestamp()) AND ertad.review_has_scope(actor,org,m.unit_id,'membership.propose'),'status',ertad.member_membership_state(m),'validFrom',m.valid_from,'validUntil',m.valid_until) ORDER BY u.name,p.name,m.id)
 FROM ertad.member_memberships(actor,org,member,target) m JOIN ertad.units u ON u.organization_id=org AND u.id=m.unit_id
 JOIN ertad.positions p ON p.organization_id=org AND p.id=m.position_id),'[]'),
 'points',CASE WHEN EXISTS(SELECT 1 FROM ertad.member_points_scopes(actor,org,member,target)) THEN
 (SELECT COALESCE(sum(e.points),0)::text FROM ertad.contribution_entries e WHERE e.organization_id=org AND e.user_id=member
 AND ertad.review_has_scope(actor,org,e.unit_id,'contribution.read') AND EXISTS(
 SELECT 1 FROM ertad.member_points_scopes(actor,org,member,target) s WHERE s.id=ANY(ertad.unit_path(org,e.unit_id)))) ELSE NULL END)
$$;

