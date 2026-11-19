-- Organization-scoped operational member discovery, separate from private identity.
ALTER TABLE ertad.permission_grants DROP CONSTRAINT permission_grants_permission_check;
ALTER TABLE ertad.permission_grants ADD CONSTRAINT permission_grants_permission_check CHECK
 (permission IN ('unit.read','member.read','workitem.create','workitem.verify','workitem.read','workitem.participate',
 'membership.propose','membership.approve','unit.propose','unit.approve','decision.read','decision.manage','decision.publish','decision.vote','qualification.verify',
 'governance.propose','governance.vote','governance.manage','finance.read','finance.record','finance.approve','contribution.manage','contribution.award','contribution.read',
 'channel.read','channel.post','channel.manage','channel.moderate'));

-- Explicit organizational display names only. No backfill from account names/emails or identity data.
CREATE TABLE ertad.organization_member_labels (
 organization_id uuid NOT NULL REFERENCES ertad.organizations(id),
 member_id uuid NOT NULL REFERENCES ertad.member_users(id),
 display_name text NOT NULL CHECK(length(trim(display_name)) BETWEEN 1 AND 120),
 PRIMARY KEY(organization_id,member_id)
);
CREATE TRIGGER a_serialize BEFORE INSERT OR UPDATE OR DELETE ON ertad.organization_member_labels
 FOR EACH ROW EXECUTE FUNCTION ertad.serialize_authority_change();

CREATE FUNCTION ertad.member_unit_visible(actor uuid,org uuid,target uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT ertad.review_has_scope(actor,org,target,'member.read') AND ertad.review_has_scope(actor,org,target,'unit.read')
$$;
CREATE FUNCTION ertad.member_memberships(actor uuid,org uuid,member uuid DEFAULT NULL,target uuid DEFAULT NULL) RETURNS SETOF ertad.memberships
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT m.* FROM ertad.memberships m WHERE m.organization_id=org AND (member IS NULL OR m.user_id=member)
 AND ertad.member_unit_visible(actor,org,m.unit_id)
 AND (target IS NULL OR target=ANY(ertad.unit_path(org,m.unit_id)))
$$;
CREATE FUNCTION ertad.member_membership_state(m ertad.memberships) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN m.status<>'active' THEN m.status
 WHEN m.valid_until<=clock_timestamp() THEN 'expired' WHEN m.valid_from>clock_timestamp() THEN 'scheduled'
 WHEN NOT EXISTS(SELECT 1 FROM ertad.positions p JOIN ertad.permission_bundles b ON (b.organization_id,b.id,b.version)=(p.organization_id,p.bundle_id,p.bundle_version)
 WHERE p.organization_id=m.organization_id AND p.id=m.position_id AND p.status='active' AND b.status='approved' AND p.bundle_version=m.bundle_version) THEN 'inactive'
 ELSE 'active' END
$$;
CREATE FUNCTION ertad.member_points_scopes(actor uuid,org uuid,member uuid,target uuid) RETURNS TABLE(id uuid,name text)
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT DISTINCT u.id,u.name FROM ertad.member_memberships(actor,org,member,target) m JOIN ertad.units u ON u.organization_id=org AND u.id=m.unit_id
 WHERE ertad.member_membership_state(m)='active' AND ertad.review_has_scope(actor,org,u.id,'contribution.read')
 AND ertad.review_has_scope(member,org,u.id,'unit.read')
$$;
CREATE FUNCTION ertad.member_summary(actor uuid,org uuid,member uuid,target uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',member,'displayName',(SELECT display_name FROM ertad.organization_member_labels WHERE organization_id=org AND member_id=member),
 'memberships',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',m.id,'unitId',m.unit_id,'unitName',u.name,'positionId',m.position_id,'positionName',p.name,
 'status',ertad.member_membership_state(m),'validFrom',m.valid_from,'validUntil',m.valid_until) ORDER BY u.name,p.name,m.id)
 FROM ertad.member_memberships(actor,org,member,target) m JOIN ertad.units u ON u.organization_id=org AND u.id=m.unit_id
 JOIN ertad.positions p ON p.organization_id=org AND p.id=m.position_id),'[]'),
 'points',CASE WHEN EXISTS(SELECT 1 FROM ertad.member_points_scopes(actor,org,member,target)) THEN
 (SELECT COALESCE(sum(e.points),0)::text FROM ertad.contribution_entries e WHERE e.organization_id=org AND e.user_id=member
 AND ertad.review_has_scope(actor,org,e.unit_id,'contribution.read') AND EXISTS(
 SELECT 1 FROM ertad.member_points_scopes(actor,org,member,target) s WHERE s.id=ANY(ertad.unit_path(org,e.unit_id)))) ELSE NULL END)
$$;

CREATE FUNCTION ertad.member_directory_command(sid uuid,token text,op text,org uuid,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid; target uuid:=(input->>'unitId')::uuid; member uuid:=(input->>'memberId')::uuid;
 data jsonb; page_number integer:=COALESCE((input->>'page')::integer,1); term text:=trim(COALESCE(input->>'search',''));
 role_term text:=trim(COALESCE(input->>'role','')); state text:=COALESCE(input->>'status','active'); total integer; work_data jsonb;
BEGIN
 actor:=ertad.review_identity(sid,token,false);
 IF op NOT IN ('contexts','units','list','detail') OR page_number NOT BETWEEN 1 AND 1000 OR length(term)>120 OR length(role_term)>120
  OR state NOT IN ('all','active','suspended','ended','expired','scheduled','inactive') THEN
  RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid directory query'; END IF;
 IF op='contexts' THEN
  PERFORM 1 FROM ertad.organizations ORDER BY id FOR SHARE;
 ELSE
  PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 END IF;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint);
 PERFORM ertad.review_identity(sid,token,false);
 IF op='contexts' THEN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',o.id,'name',o.name) ORDER BY o.name,o.id),'[]') INTO data
  FROM ertad.organizations o WHERE o.status='active' AND EXISTS(SELECT 1 FROM ertad.units u WHERE u.organization_id=o.id AND ertad.member_unit_visible(actor,o.id,u.id));
 ELSE
  IF NOT EXISTS(SELECT 1 FROM ertad.units u WHERE u.organization_id=org AND ertad.member_unit_visible(actor,org,u.id))
   OR (target IS NOT NULL AND NOT ertad.member_unit_visible(actor,org,target)) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
  IF op='units' THEN
   WITH visible AS (SELECT u.id,u.name FROM ertad.units u WHERE u.organization_id=org AND ertad.member_unit_visible(actor,org,u.id) AND position(lower(term) IN lower(u.name))>0),
   paged AS (SELECT * FROM visible ORDER BY name,id LIMIT 25 OFFSET(page_number-1)*25)
   SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(to_jsonb(paged) ORDER BY name,id) FROM paged),'[]'),'total',(SELECT count(*) FROM visible),'page',page_number,'pageSize',25) INTO data;
  ELSIF op='list' THEN
   WITH visible AS (SELECT DISTINCT m.user_id FROM ertad.member_memberships(actor,org,NULL,target) m JOIN ertad.positions p ON p.organization_id=org AND p.id=m.position_id
    LEFT JOIN ertad.organization_member_labels l ON l.organization_id=org AND l.member_id=m.user_id
    WHERE (state='all' OR ertad.member_membership_state(m)=state) AND position(lower(role_term) IN lower(p.name))>0
    AND (term='' OR lower(m.user_id::text)=lower(term) OR position(lower(term) IN lower(COALESCE(l.display_name,'')))>0)),
   paged AS (SELECT v.user_id FROM visible v LEFT JOIN ertad.organization_member_labels l ON l.organization_id=org AND l.member_id=v.user_id ORDER BY lower(l.display_name) NULLS LAST,v.user_id LIMIT 25 OFFSET(page_number-1)*25)
   SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(ertad.member_summary(actor,org,p.user_id,target) ORDER BY lower(l.display_name) NULLS LAST,p.user_id)
    FROM paged p LEFT JOIN ertad.organization_member_labels l ON l.organization_id=org AND l.member_id=p.user_id),'[]'),
    'total',(SELECT count(*) FROM visible),'page',page_number,'pageSize',25) INTO data;
  ELSE
   IF member IS NULL OR NOT EXISTS(SELECT 1 FROM ertad.member_memberships(actor,org,member,target)) THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Member unavailable'; END IF;
   data:=ertad.member_summary(actor,org,member,target);
   WITH visible AS (SELECT w.id,w.title,w.unit_id,a.status,a.progress FROM ertad.work_assignments a
    JOIN ertad.work_items w ON w.organization_id=a.organization_id AND w.id=a.work_id
    WHERE a.organization_id=org AND a.user_id=member AND ertad.member_unit_visible(actor,org,w.unit_id)
    AND (target IS NULL OR target=ANY(ertad.unit_path(org,w.unit_id))) AND ertad.work_visible(actor,w)
    AND (member=actor OR ertad.review_has_scope(actor,org,w.unit_id,'workitem.create') OR ertad.review_has_scope(actor,org,w.unit_id,'workitem.verify'))),
   paged AS (SELECT * FROM visible ORDER BY title,id LIMIT 25 OFFSET(page_number-1)*25)
   SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'title',title,'status',status,'progress',progress) ORDER BY title,id) FROM paged),'[]'),
    'total',(SELECT count(*) FROM visible),'page',page_number,'pageSize',25,'verified',(SELECT count(*) FROM visible WHERE status='verified')) INTO work_data;
   data:=data||jsonb_build_object('work',work_data,'pointsScopes',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.name,s.id) FROM ertad.member_points_scopes(actor,org,member,target) s),'[]'),
    'canPropose',member<>actor AND EXISTS(SELECT 1 FROM ertad.member_memberships(actor,org,member,target) m WHERE ertad.review_has_scope(actor,org,m.unit_id,'membership.propose')));
  END IF;
 END IF;
 -- Search terms and names never enter audit payloads; data is reevaluated after the required audit.
 RETURN jsonb_build_object('data',data,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op));
END $$;
REVOKE ALL ON ertad.organization_member_labels FROM PUBLIC,ertad_app;
REVOKE ALL ON FUNCTION ertad.member_unit_visible(uuid,uuid,uuid),ertad.member_memberships(uuid,uuid,uuid,uuid),ertad.member_membership_state(ertad.memberships),
 ertad.member_points_scopes(uuid,uuid,uuid,uuid),ertad.member_summary(uuid,uuid,uuid,uuid) FROM PUBLIC,ertad_app;
REVOKE ALL ON FUNCTION ertad.member_directory_command(uuid,text,text,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.member_directory_command(uuid,text,text,uuid,jsonb) TO ertad_app;
