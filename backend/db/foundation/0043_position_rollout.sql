-- Explicit adoption of an approved direct successor; no automatic member migration.
ALTER TABLE ertad.membership_reviews DROP CONSTRAINT membership_reviews_kind_check;
ALTER TABLE ertad.membership_reviews ADD CHECK(kind IN ('grant','transfer','revoke','suspend','resume','revision'));
ALTER TABLE ertad.membership_reviews ADD COLUMN revision_snapshot jsonb;
ALTER TABLE ertad.membership_reviews ADD CHECK((kind='revision')=(revision_snapshot IS NOT NULL));
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='ertad.membership_reviews'::regclass AND contype='c'
 AND pg_get_constraintdef(oid) LIKE '%valid_until%' LOOP
 EXECUTE format('ALTER TABLE ertad.membership_reviews DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE ertad.membership_reviews ADD CHECK((kind IN ('revoke','suspend','resume','revision') AND valid_until IS NULL) OR
 (kind IN ('grant','transfer') AND valid_until IS NOT NULL AND isfinite(valid_until) AND valid_until>expires_at AND valid_until<=created_at+interval '366 days'));

CREATE FUNCTION ertad.position_revision_snapshot(org uuid,destination uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_object_agg(side,definition) FROM (
 SELECT side,to_jsonb(p)||jsonb_build_object('grants',COALESCE((SELECT jsonb_agg(jsonb_build_object('permission',g.permission,'scope',g.scope) ORDER BY g.permission,g.scope)
 FROM ertad.permission_grants g WHERE g.organization_id=p.organization_id AND g.bundle_id=p.bundle_id AND g.bundle_version=p.bundle_version),'[]')) definition
 FROM ertad.positions d JOIN ertad.positions p ON p.organization_id=d.organization_id AND p.id IN(d.id,d.predecessor_id)
 CROSS JOIN LATERAL (SELECT CASE WHEN p.id=d.id THEN 'destination' ELSE 'source' END side) s
 WHERE d.organization_id=org AND d.id=destination) definitions
$$;
CREATE FUNCTION ertad.position_revision_comparison(snapshot jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('sourceName',snapshot#>>'{source,name}','destinationName',snapshot#>>'{destination,name}',
 'added',COALESCE((SELECT jsonb_agg(g) FROM jsonb_array_elements(snapshot#>'{destination,grants}') g WHERE NOT (snapshot#>'{source,grants}') @> jsonb_build_array(g)),'[]'),
 'removed',COALESCE((SELECT jsonb_agg(g) FROM jsonb_array_elements(snapshot#>'{source,grants}') g WHERE NOT (snapshot#>'{destination,grants}') @> jsonb_build_array(g)),'[]'),
 'unchanged',COALESCE((SELECT jsonb_agg(g) FROM jsonb_array_elements(snapshot#>'{destination,grants}') g WHERE (snapshot#>'{source,grants}') @> jsonb_build_array(g)),'[]'))
$$;
CREATE FUNCTION ertad.position_rollout_blocker(m ertad.memberships,destination uuid) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT CASE
 WHEN m.status NOT IN ('active','suspended') OR m.valid_until<=clock_timestamp() THEN 'inactive'
 WHEN NOT EXISTS(SELECT 1 FROM ertad.member_users WHERE id=m.user_id AND status='active') THEN 'inactive'
 WHEN ertad.membership_change_blocked(m.organization_id,m.user_id,m.unit_id) THEN 'responsibilities'
 WHEN EXISTS(SELECT 1 FROM ertad.memberships n WHERE n.organization_id=m.organization_id AND n.user_id=m.user_id AND n.position_id=destination AND n.status IN ('active','suspended') AND (n.valid_until IS NULL OR n.valid_until>clock_timestamp())) THEN 'overlap'
 WHEN EXISTS(SELECT 1 FROM ertad.membership_reviews r WHERE r.organization_id=m.organization_id AND r.source_id=m.id AND r.status='pending' AND r.expires_at>clock_timestamp()) THEN 'pending'
 ELSE NULL END
$$;
ALTER FUNCTION ertad.membership_change_assert(ertad.membership_reviews) RENAME TO membership_before_revision_assert;
CREATE FUNCTION ertad.membership_change_assert(r ertad.membership_reviews) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE m ertad.memberships; n ertad.memberships; original ertad.memberships; expected jsonb; snapshot jsonb;
BEGIN
 IF r.kind<>'revision' THEN PERFORM ertad.membership_before_revision_assert(r); RETURN; END IF;
 SELECT * INTO m FROM ertad.memberships WHERE organization_id=r.organization_id AND id=r.source_id;
 original:=jsonb_populate_record(NULL::ertad.memberships,r.source_snapshot);
 expected:=r.source_snapshot;
 IF r.status='approved' THEN expected:=expected||jsonb_build_object('status','ended','version',original.version+1); END IF;
 snapshot:=ertad.position_revision_snapshot(r.organization_id,r.position_id);
 IF m.id IS NULL OR to_jsonb(m) IS DISTINCT FROM expected OR original.status NOT IN ('active','suspended') OR original.valid_until<=clock_timestamp()
 OR snapshot IS DISTINCT FROM r.revision_snapshot OR snapshot#>>'{source,status}'<>'active' OR snapshot#>>'{destination,status}'<>'active'
 OR (snapshot#>>'{source,id}')::uuid IS DISTINCT FROM original.position_id
 OR (snapshot#>>'{source,bundle_version}')::integer IS DISTINCT FROM original.bundle_version
 OR (snapshot#>>'{destination,unit_id}')::uuid IS DISTINCT FROM original.unit_id
 OR (snapshot#>>'{destination,bundle_id}')::uuid IS DISTINCT FROM r.bundle_id
 OR (snapshot#>>'{destination,bundle_version}')::integer IS DISTINCT FROM r.bundle_version
 OR r.source_path IS DISTINCT FROM ertad.unit_path(r.organization_id,m.unit_id)
 OR r.destination_path IS DISTINCT FROM r.source_path
 OR NOT EXISTS(SELECT 1 FROM ertad.member_users WHERE id=r.target_id AND status='active')
 OR NOT EXISTS(SELECT 1 FROM ertad.permission_bundles WHERE organization_id=r.organization_id AND id=r.bundle_id AND version=r.bundle_version AND status='approved')
 OR ertad.membership_change_blocked(r.organization_id,r.target_id,m.unit_id)
 OR NOT ertad.position_ceiling(r.requester_id,r.organization_id,r.unit_id,snapshot->'destination')
 OR (r.status='approved' AND NOT ertad.position_ceiling(r.decision_by,r.organization_id,r.unit_id,snapshot->'destination'))
 OR EXISTS(SELECT 1 FROM ertad.memberships x WHERE x.organization_id=r.organization_id AND x.user_id=r.target_id AND x.position_id=r.position_id
 AND x.id IS DISTINCT FROM r.membership_id AND x.status IN ('active','suspended') AND (x.valid_until IS NULL OR x.valid_until>clock_timestamp()))
 THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Position adoption changed or blocked'; END IF;
 IF r.status='approved' THEN
 SELECT * INTO n FROM ertad.memberships WHERE organization_id=r.organization_id AND id=r.membership_id;
 IF n.id IS NULL OR to_jsonb(n) IS DISTINCT FROM (r.source_snapshot||jsonb_build_object('id',r.membership_id,'position_id',r.position_id,'bundle_version',r.bundle_version,'version',0)) THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Replacement term changed'; END IF;
 END IF;
END $$;

ALTER FUNCTION ertad.membership_review_command(uuid,text,text,uuid,jsonb) RENAME TO membership_before_revision_command;
CREATE FUNCTION ertad.membership_review_command(sid uuid,token text,op text,org uuid,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_column
DECLARE actor uuid; p ertad.positions; m ertad.memberships; r ertad.membership_reviews; snapshot jsonb; result jsonb; envelope jsonb;
 changed boolean:=false; mid uuid; expiry timestamptz; decision text; query text:=trim(COALESCE(input->>'search','')); page integer:=COALESCE((input->>'page')::integer,1);
BEGIN
 IF op='decide' THEN SELECT * INTO r FROM ertad.membership_reviews WHERE organization_id=org AND id=(input->>'id')::uuid; END IF;
 IF NOT COALESCE(op='revisionOptions' OR (op='change' AND input->>'kind'='revision') OR (op='decide' AND r.kind='revision'),false) THEN
 envelope:=ertad.membership_before_revision_command(sid,token,op,org,input);
 IF op='detail' THEN
 SELECT * INTO r FROM ertad.membership_reviews WHERE organization_id=org AND id=(input->>'id')::uuid;
 envelope:=jsonb_set(envelope,'{data}',((envelope->'data')-'revision_snapshot')||CASE WHEN r.kind='revision' THEN jsonb_build_object('comparison',ertad.position_revision_comparison(r.revision_snapshot)) ELSE '{}'::jsonb END);
 END IF;
 RETURN envelope;
 END IF;
 actor:=ertad.review_identity(sid,token,op<>'revisionOptions');
 IF op='revisionOptions' THEN PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR SHARE;
 ELSE PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR UPDATE; END IF;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint);
 PERFORM ertad.review_identity(sid,token,op<>'revisionOptions');
 IF op IN ('revisionOptions','change') THEN
 SELECT * INTO p FROM ertad.positions WHERE organization_id=org AND id=(input->>'positionId')::uuid;
 IF p.id IS NULL OR p.predecessor_id IS NULL OR NOT ertad.member_unit_visible(actor,org,p.unit_id)
 OR NOT (ertad.review_has_scope(actor,org,p.unit_id,'membership.propose') OR (op='revisionOptions' AND ertad.review_has_scope(actor,org,p.unit_id,'membership.approve'))) THEN
 RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 snapshot:=ertad.position_revision_snapshot(org,p.id);
 END IF;
 IF op='revisionOptions' THEN
 IF page NOT BETWEEN 1 AND 1000 OR length(query)>120 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid page'; END IF;
 WITH candidates AS (
 SELECT m.*,l.display_name,ertad.member_membership_state(m) state,ertad.position_rollout_blocker(m,p.id) blocker,
 (SELECT jsonb_build_object('id',v.id,'status',CASE WHEN v.status='pending' AND v.expires_at<=clock_timestamp() THEN 'expired' ELSE v.status END)
 FROM ertad.membership_reviews v WHERE v.organization_id=org AND v.source_id=m.id AND v.kind='revision' AND v.position_id=p.id AND ertad.review_visible(actor,v)
 ORDER BY v.created_at DESC,v.id DESC LIMIT 1) review
 FROM ertad.memberships m LEFT JOIN ertad.organization_member_labels l ON l.organization_id=m.organization_id AND l.member_id=m.user_id
 WHERE m.organization_id=org AND m.position_id=p.predecessor_id
 AND (m.status IN ('active','suspended') OR EXISTS(SELECT 1 FROM ertad.membership_reviews v WHERE v.organization_id=org AND v.source_id=m.id AND v.kind='revision' AND v.position_id=p.id AND ertad.review_visible(actor,v)))
 AND (query='' OR m.user_id::text=query OR strpos(lower(COALESCE(l.display_name,'')),lower(query))>0)
 ), selected AS (SELECT * FROM candidates ORDER BY id LIMIT 25 OFFSET (page-1)*25)
 SELECT jsonb_build_object('definitionKey',md5(snapshot::text),'comparison',ertad.position_revision_comparison(snapshot),'page',page,'total',(SELECT count(*) FROM candidates),
 'items',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',s.id,'memberId',s.user_id,'displayName',s.display_name,'version',s.version,'state',s.state,'validUntil',s.valid_until,'review',s.review,
 'blocker',CASE WHEN s.user_id=actor THEN 'self' WHEN p.status<>'active' OR snapshot#>>'{source,status}'<>'active'
 OR NOT EXISTS(SELECT 1 FROM ertad.permission_bundles WHERE organization_id=org AND id=p.bundle_id AND version=p.bundle_version AND status='approved') THEN 'definition'
 WHEN NOT ertad.review_has_scope(actor,org,p.unit_id,'membership.propose') OR NOT ertad.position_ceiling(actor,org,p.unit_id,snapshot->'destination') THEN 'authority' ELSE s.blocker END) ORDER BY s.id) FROM selected s),'[]')) INTO result;
 ELSIF op='change' THEN
 SELECT * INTO m FROM ertad.memberships WHERE organization_id=org AND id=(input->>'membershipId')::uuid;
 IF m.id IS NULL OR m.user_id=actor OR m.unit_id<>p.unit_id OR m.position_id<>p.predecessor_id THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 SELECT * INTO r FROM ertad.membership_reviews WHERE organization_id=org AND requester_id=actor AND request_key=(input->>'key')::uuid;
 IF FOUND THEN
 IF (r.kind,r.source_id,(r.source_snapshot->>'version')::integer,r.position_id,md5(r.revision_snapshot::text),r.reason,r.expires_at)
 IS DISTINCT FROM ('revision',m.id,(input->>'version')::integer,p.id,input->>'definitionKey',input->>'reason',(input->>'expiresAt')::timestamptz) THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request conflict'; END IF;
 ELSE
 expiry:=(input->>'expiresAt')::timestamptz;
 IF m.version IS DISTINCT FROM (input->>'version')::integer OR md5(snapshot::text) IS DISTINCT FROM input->>'definitionKey'
 OR ertad.position_rollout_blocker(m,p.id) IS NOT NULL OR input ? 'validUntil'
 OR expiry<=clock_timestamp() OR expiry>clock_timestamp()+interval '7 days' THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request conflict'; END IF;
 INSERT INTO ertad.membership_reviews(organization_id,requester_id,target_id,unit_id,position_id,bundle_id,bundle_version,reason,expires_at,request_key,kind,source_id,source_snapshot,source_path,destination_path,revision_snapshot)
 VALUES(org,actor,m.user_id,m.unit_id,p.id,p.bundle_id,p.bundle_version,input->>'reason',expiry,(input->>'key')::uuid,'revision',m.id,to_jsonb(m),ertad.unit_path(org,m.unit_id),ertad.unit_path(org,p.unit_id),snapshot) RETURNING * INTO r;
 PERFORM ertad.membership_change_assert(r); changed:=true;
 END IF;
 result:=jsonb_build_object('id',r.id,'status',r.status);
 ELSE
 SELECT * INTO r FROM ertad.membership_reviews WHERE organization_id=org AND id=(input->>'id')::uuid;
 IF actor IN(r.requester_id,r.target_id) OR NOT ertad.membership_change_scope(actor,r,'membership.approve') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 decision:=input->>'decision';
 IF decision NOT IN ('approved','rejected') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid decision'; END IF;
 IF r.status<>'pending' THEN
 IF (r.status,r.decision_by,r.decision_key,r.decision_reason) IS DISTINCT FROM (decision,actor,(input->>'key')::uuid,input->>'reason') THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request conflict'; END IF;
 ELSE
 IF r.expires_at<=clock_timestamp() OR NOT ertad.membership_change_scope(r.requester_id,r,'membership.propose') THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request conflict'; END IF;
 IF decision='approved' THEN
 IF NOT ertad.position_ceiling(actor,org,r.unit_id,r.revision_snapshot->'destination') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Delegation ceiling exceeded'; END IF;
 PERFORM ertad.membership_change_assert(r);
 SELECT * INTO m FROM ertad.memberships WHERE organization_id=org AND id=r.source_id;
 UPDATE ertad.memberships SET status='ended' WHERE organization_id=org AND id=m.id;
 INSERT INTO ertad.memberships(organization_id,user_id,unit_id,position_id,bundle_version,status,valid_from,valid_until)
 VALUES(org,m.user_id,m.unit_id,r.position_id,r.bundle_version,m.status,m.valid_from,m.valid_until) RETURNING id INTO mid;
 END IF;
 UPDATE ertad.membership_reviews SET status=decision,decision_by=actor,decision_key=(input->>'key')::uuid,decision_reason=input->>'reason',decision_at=clock_timestamp(),membership_id=mid
 WHERE organization_id=org AND id=r.id RETURNING * INTO r;
 INSERT INTO ertad.review_notifications(organization_id,review_id,recipient_id) VALUES(org,r.id,r.requester_id),(org,r.id,r.target_id);
 changed:=true;
 END IF;
 result:=jsonb_build_object('id',r.id,'status',r.status);
 END IF;
 RETURN jsonb_build_object('data',result,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'reviewId',r.id,'changed',changed));
END $$;

ALTER FUNCTION ertad.position_catalogue(uuid,uuid,jsonb) RENAME TO position_before_rollout_catalogue;
CREATE FUNCTION ertad.position_catalogue(actor uuid,org uuid,input jsonb) RETURNS jsonb LANGUAGE sql SET search_path=pg_catalog AS $$
 SELECT result||jsonb_build_object('items',COALESCE((SELECT jsonb_agg(item||jsonb_build_object('canRollout',item->>'predecessorId' IS NOT NULL
 AND ertad.member_unit_visible(actor,org,(item->>'unitId')::uuid) AND (ertad.review_has_scope(actor,org,(item->>'unitId')::uuid,'membership.propose') OR ertad.review_has_scope(actor,org,(item->>'unitId')::uuid,'membership.approve'))) ORDER BY ordinal)
 FROM jsonb_array_elements(result->'items') WITH ORDINALITY entries(item,ordinal)),'[]')) FROM (SELECT ertad.position_before_rollout_catalogue(actor,org,input) result) base
$$;
REVOKE ALL ON FUNCTION ertad.position_revision_snapshot(uuid,uuid),ertad.position_revision_comparison(jsonb),ertad.position_rollout_blocker(ertad.memberships,uuid),
 ertad.membership_before_revision_assert(ertad.membership_reviews),ertad.membership_change_assert(ertad.membership_reviews),
 ertad.membership_before_revision_command(uuid,text,text,uuid,jsonb),ertad.position_before_rollout_catalogue(uuid,uuid,jsonb),ertad.position_catalogue(uuid,uuid,jsonb) FROM PUBLIC,ertad_app;
REVOKE ALL ON FUNCTION ertad.membership_review_command(uuid,text,text,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.membership_review_command(uuid,text,text,uuid,jsonb) TO ertad_app;

CREATE OR REPLACE FUNCTION ertad.position_retirement_blocked(org uuid,source uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM ertad.memberships WHERE organization_id=org AND position_id=source
   AND status IN ('active','suspended') AND (valid_until IS NULL OR valid_until>clock_timestamp()))
 OR EXISTS(SELECT 1 FROM ertad.membership_reviews WHERE organization_id=org AND position_id=source
   AND kind IN ('grant','transfer','revision') AND status='pending' AND expires_at>clock_timestamp())
 OR EXISTS(SELECT 1 FROM ertad.collective_proposals WHERE organization_id=org AND kind='position_revision'
   AND parameters->>'sourceId'=source::text AND status='pending' AND deadline>clock_timestamp())
$$;
