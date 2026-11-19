-- Independently reviewed, membership-local suspension and resumption. No new grants.
ALTER TABLE ertad.membership_reviews DROP CONSTRAINT membership_reviews_kind_check;
ALTER TABLE ertad.membership_reviews ADD CHECK(kind IN ('grant','transfer','revoke','suspend','resume'));
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='ertad.membership_reviews'::regclass AND contype='c'
 AND pg_get_constraintdef(oid) LIKE '%valid_until%' LOOP
 EXECUTE format('ALTER TABLE ertad.membership_reviews DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE ertad.membership_reviews ADD CHECK((kind IN ('revoke','suspend','resume') AND valid_until IS NULL) OR
 (kind IN ('grant','transfer') AND valid_until IS NOT NULL AND isfinite(valid_until) AND valid_until>expires_at AND valid_until<=created_at+interval '366 days'));

CREATE FUNCTION ertad.membership_pause_available(m ertad.memberships,kind text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT kind IN ('suspend','resume') AND m.status=CASE kind WHEN 'suspend' THEN 'active' ELSE 'suspended' END
 AND (m.valid_until IS NULL OR m.valid_until>clock_timestamp())
 AND EXISTS(SELECT 1 FROM ertad.member_users WHERE id=m.user_id AND status='active')
 AND (kind='suspend' OR (
 EXISTS(SELECT 1 FROM ertad.positions p JOIN ertad.permission_bundles b ON b.organization_id=p.organization_id AND b.id=p.bundle_id AND b.version=p.bundle_version
 WHERE p.organization_id=m.organization_id AND p.id=m.position_id AND p.unit_id=m.unit_id AND p.bundle_version=m.bundle_version AND p.status='active' AND b.status='approved')
 AND NOT EXISTS(SELECT 1 FROM ertad.memberships n WHERE n.organization_id=m.organization_id AND n.user_id=m.user_id AND n.position_id=m.position_id
 AND n.id<>m.id AND n.status='active' AND (n.valid_until IS NULL OR n.valid_until>clock_timestamp()))))
$$;

ALTER FUNCTION ertad.membership_change_assert(ertad.membership_reviews) RENAME TO membership_before_pause_assert;
CREATE FUNCTION ertad.membership_change_assert(r ertad.membership_reviews) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE m ertad.memberships; original ertad.memberships; expected jsonb;
BEGIN
 IF r.kind NOT IN ('suspend','resume') THEN PERFORM ertad.membership_before_pause_assert(r); RETURN; END IF;
 SELECT * INTO m FROM ertad.memberships WHERE organization_id=r.organization_id AND id=r.source_id;
 original:=jsonb_populate_record(NULL::ertad.memberships,r.source_snapshot);
 expected:=r.source_snapshot;
 IF r.status='approved' THEN expected:=expected||jsonb_build_object('status',CASE r.kind WHEN 'suspend' THEN 'suspended' ELSE 'active' END,'version',original.version+1); END IF;
 IF m.id IS NULL OR to_jsonb(m) IS DISTINCT FROM expected OR NOT ertad.membership_pause_available(original,r.kind)
 OR r.source_path IS DISTINCT FROM ertad.unit_path(r.organization_id,m.unit_id)
 OR r.destination_path IS DISTINCT FROM ertad.unit_path(r.organization_id,r.unit_id)
 OR (m.user_id,m.unit_id,m.position_id,m.bundle_version) IS DISTINCT FROM (r.target_id,r.unit_id,r.position_id,r.bundle_version)
 OR (r.kind='resume' AND NOT EXISTS(SELECT 1 FROM ertad.positions WHERE organization_id=r.organization_id AND id=r.position_id AND bundle_id=r.bundle_id AND bundle_version=r.bundle_version))
 THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Membership or original authority changed'; END IF;
 -- Work obligations are preserved. They must not prevent a reviewed authority restriction.
END $$;

ALTER FUNCTION ertad.member_summary(uuid,uuid,uuid,uuid) RENAME TO member_before_pause_summary;
CREATE FUNCTION ertad.member_summary(actor uuid,org uuid,member uuid,target uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_set(s,'{memberships}',COALESCE((SELECT jsonb_agg(item||jsonb_build_object('canChange',m.user_id<>actor
 AND ertad.review_has_scope(actor,org,m.unit_id,'membership.propose') AND (
 (m.status IN ('active','suspended') AND m.valid_from<=clock_timestamp() AND (m.valid_until IS NULL OR m.valid_until>clock_timestamp()))
 OR ertad.membership_pause_available(m,'suspend') OR ertad.membership_pause_available(m,'resume'))) ORDER BY ord)
 FROM jsonb_array_elements(s->'memberships') WITH ORDINALITY AS entries(item,ord)
 JOIN ertad.memberships m ON m.organization_id=org AND m.id=(item->>'id')::uuid),'[]'))
 FROM (SELECT ertad.member_before_pause_summary(actor,org,member,target) s) original
$$;
REVOKE ALL ON FUNCTION ertad.membership_pause_available(ertad.memberships,text),ertad.membership_before_pause_assert(ertad.membership_reviews),
 ertad.membership_change_assert(ertad.membership_reviews),ertad.member_before_pause_summary(uuid,uuid,uuid,uuid),ertad.member_summary(uuid,uuid,uuid,uuid) FROM PUBLIC,ertad_app;

CREATE OR REPLACE FUNCTION ertad.membership_review_command(sid uuid,token text,op text,org uuid,input jsonb) RETURNS jsonb
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
 'state',ertad.member_membership_state(m),'canSuspend',ertad.membership_pause_available(m,'suspend'),
 'canResume',ertad.membership_pause_available(m,'resume'),
 'canRevoke',m.status IN ('active','suspended') AND m.valid_from<=clock_timestamp() AND (m.valid_until IS NULL OR m.valid_until>clock_timestamp()) AND NOT ertad.membership_change_blocked(org,m.user_id,m.unit_id),
 'destinations',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'unitName',u.name) ORDER BY u.name,p.name,p.id),'[]')
 FROM ertad.positions p JOIN ertad.units u ON u.organization_id=p.organization_id AND u.id=p.unit_id
 JOIN ertad.permission_bundles b ON b.organization_id=p.organization_id AND b.id=p.bundle_id AND b.version=p.bundle_version
 WHERE p.organization_id=org AND p.id<>m.position_id AND p.status='active' AND b.status='approved'
 AND ertad.member_unit_visible(actor,org,p.unit_id) AND ertad.review_has_scope(actor,org,p.unit_id,'membership.propose')));
 ELSE
 IF change_kind NOT IN ('transfer','revoke','suspend','resume') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid change'; END IF;
 key:=(input->>'key')::uuid; expiry:=(input->>'expiresAt')::timestamptz; until_at:=(input->>'validUntil')::timestamptz;
 SELECT * INTO p FROM ertad.positions WHERE organization_id=org AND id=CASE WHEN change_kind<>'transfer' THEN m.position_id ELSE (input->>'positionId')::uuid END;
 IF NOT FOUND OR NOT ertad.member_unit_visible(actor,org,p.unit_id) OR NOT ertad.review_has_scope(actor,org,p.unit_id,'membership.propose') THEN
 RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 SELECT * INTO r FROM ertad.membership_reviews WHERE organization_id=org AND requester_id=actor AND request_key=key;
 IF FOUND THEN
 IF (r.kind,r.source_id,(r.source_snapshot->>'version')::integer,r.position_id,r.reason,r.expires_at,r.valid_until)
 IS DISTINCT FROM (change_kind,m.id,(input->>'version')::integer,p.id,input->>'reason',expiry,until_at) THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request conflict'; END IF;
 ELSE
 IF m.version IS DISTINCT FROM (input->>'version')::integer
 OR (change_kind IN ('suspend','resume') AND NOT ertad.membership_pause_available(m,change_kind))
 OR (change_kind IN ('transfer','revoke') AND (m.status NOT IN ('active','suspended') OR (change_kind='transfer' AND m.status<>'active') OR m.valid_from>clock_timestamp() OR m.valid_until<=clock_timestamp()))
 OR expiry<=clock_timestamp() OR expiry>clock_timestamp()+interval '7 days'
 OR (change_kind='transfer' AND (p.id=m.position_id OR until_at IS NULL OR until_at<=expiry OR until_at>clock_timestamp()+interval '365 days' OR until_at>m.valid_until))
 OR (change_kind<>'transfer' AND (until_at IS NOT NULL OR input ? 'positionId')) THEN
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
 UPDATE ertad.memberships SET status=CASE r.kind WHEN 'suspend' THEN 'suspended' WHEN 'resume' THEN 'active' ELSE 'ended' END WHERE organization_id=org AND id=r.source_id;
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
 'sourceValidUntil',r.source_snapshot->'valid_until',
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

