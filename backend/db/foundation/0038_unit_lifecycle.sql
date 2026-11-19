-- Reviewed unit changes reuse the existing immutable request/inbox and audit boundary.
ALTER TABLE ertad.permission_grants DROP CONSTRAINT permission_grants_permission_check;
ALTER TABLE ertad.permission_grants ADD CONSTRAINT permission_grants_permission_check CHECK
 (permission IN ('unit.read','member.read','workitem.create','workitem.verify','workitem.read','workitem.participate',
 'membership.propose','membership.approve','unit.propose','unit.approve','unit.change.propose','unit.change.approve',
 'decision.read','decision.manage','decision.publish','decision.vote','qualification.verify',
 'governance.propose','governance.vote','governance.manage','finance.read','finance.record','finance.approve',
 'contribution.manage','contribution.award','contribution.read','channel.read','channel.post','channel.manage','channel.moderate'));

ALTER TABLE ertad.units ADD COLUMN version integer NOT NULL DEFAULT 0 CHECK(version>=0);
CREATE FUNCTION ertad.unit_version() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 NEW.version:=OLD.version+CASE WHEN (NEW.name,NEW.parent_id,NEW.status,NEW.kind) IS DISTINCT FROM
 (OLD.name,OLD.parent_id,OLD.status,OLD.kind) THEN 1 ELSE 0 END;
 RETURN NEW;
END; $$;
CREATE TRIGGER c_unit_version BEFORE UPDATE ON ertad.units FOR EACH ROW EXECUTE FUNCTION ertad.unit_version();

ALTER TABLE ertad.unit_reviews ADD COLUMN kind text NOT NULL DEFAULT 'create' CHECK(kind IN ('create','rename','archive','restore'));
ALTER TABLE ertad.unit_reviews ADD COLUMN target_id uuid;
ALTER TABLE ertad.unit_reviews ADD COLUMN target_version integer;
ALTER TABLE ertad.unit_reviews ADD COLUMN original_name text;
ALTER TABLE ertad.unit_reviews ADD FOREIGN KEY(organization_id,target_id) REFERENCES ertad.units(organization_id,id);
ALTER TABLE ertad.unit_reviews ADD CHECK(
 (kind='create' AND target_id IS NULL AND target_version IS NULL AND original_name IS NULL)
 OR (kind IN ('rename','archive','restore') AND target_id IS NOT NULL AND target_version IS NOT NULL AND target_version>=0 AND original_name IS NOT NULL
 AND (kind='rename' OR name=original_name)));
CREATE INDEX unit_reviews_target ON ertad.unit_reviews(organization_id,target_id,status);

-- Block archival of attached operational history until each domain supports archival reads.
-- Counts/identities are never returned; only categories after scoped unit access.
CREATE FUNCTION ertad.unit_archive_blockers(org uuid,target uuid,excluded_review uuid DEFAULT NULL) RETURNS text[]
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT array_remove(ARRAY[
 CASE WHEN EXISTS(SELECT 1 FROM ertad.units WHERE organization_id=org AND parent_id=target) THEN 'children' END,
 CASE WHEN EXISTS(SELECT 1 FROM ertad.memberships WHERE organization_id=org AND unit_id=target) THEN 'memberships' END,
 CASE WHEN EXISTS(SELECT 1 FROM ertad.positions WHERE organization_id=org AND unit_id=target) THEN 'positions' END,
 CASE WHEN EXISTS(SELECT 1 FROM ertad.work_items WHERE organization_id=org AND unit_id=target) THEN 'work' END,
 CASE WHEN EXISTS(SELECT 1 FROM ertad.decisions WHERE organization_id=org AND unit_id=target) THEN 'decisions' END,
 CASE WHEN EXISTS(SELECT 1 FROM ertad.channels WHERE organization_id=org AND unit_id=target) THEN 'channels' END,
 CASE WHEN EXISTS(SELECT 1 FROM ertad.mobilization_events WHERE organization_id=org AND unit_id=target) THEN 'events' END,
 CASE WHEN EXISTS(SELECT 1 FROM ertad.collective_proposals WHERE organization_id=org AND unit_id=target) THEN 'governance' END,
 CASE WHEN EXISTS(SELECT 1 FROM ertad.collective_policies WHERE organization_id=org AND unit_id=target) THEN 'policies' END,
 CASE WHEN EXISTS(SELECT 1 FROM ertad.qualification_definitions WHERE organization_id=org AND unit_id=target) THEN 'qualifications' END,
 CASE WHEN EXISTS(SELECT 1 FROM ertad.contribution_rules WHERE organization_id=org AND (unit_id=target OR allowed_unit_id=target)) THEN 'contribution' END,
 CASE WHEN EXISTS(SELECT 1 FROM ertad.activity_entries WHERE organization_id=org AND unit_id=target) THEN 'activity' END,
 CASE WHEN EXISTS(SELECT 1 FROM ertad.work_assignments WHERE organization_id=org AND review_unit_id=target) THEN 'work_reviews' END,
 CASE WHEN EXISTS(SELECT 1 FROM ertad.membership_reviews WHERE organization_id=org AND unit_id=target AND status='pending' AND expires_at>clock_timestamp()) THEN 'membership_requests' END,
 CASE WHEN EXISTS(SELECT 1 FROM ertad.unit_reviews WHERE organization_id=org AND (parent_id=target OR target_id=target)
   AND id IS DISTINCT FROM excluded_review AND status='pending' AND expires_at>clock_timestamp()) THEN 'unit_requests' END
 ]::text[],NULL);
$$;

CREATE OR REPLACE FUNCTION ertad.unit_review_visible(actor uuid,r ertad.unit_reviews) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT ertad.review_has_scope(actor,r.organization_id,r.parent_id,'unit.read') AND
 ((actor=r.requester_id AND ertad.review_has_scope(actor,r.organization_id,r.parent_id,CASE WHEN r.kind='create' THEN 'unit.propose' ELSE 'unit.change.propose' END))
 OR (actor<>r.requester_id AND ertad.review_has_scope(actor,r.organization_id,r.parent_id,CASE WHEN r.kind='create' THEN 'unit.approve' ELSE 'unit.change.approve' END)));
$$;

CREATE OR REPLACE FUNCTION ertad.unit_command(sid uuid,token text,op text,org uuid,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_column
DECLARE actor uuid; r ertad.unit_reviews; result jsonb; changed boolean:=false;
  target ertad.units; change_kind text; propose_permission text; approve_permission text;
  parent uuid; expiry timestamptz; page integer; view_name text; new_unit uuid;
BEGIN
  IF op NOT IN ('contexts','units','list','detail','propose','change','decide') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid operation'; END IF;
  actor:=ertad.review_identity(sid,token,op IN ('propose','change','decide'));
  IF op='contexts' THEN
    PERFORM 1 FROM ertad.organizations o WHERE EXISTS(SELECT 1 FROM ertad.memberships m WHERE m.organization_id=o.id AND m.user_id=actor) ORDER BY o.id FOR SHARE;
  ELSIF op IN ('propose','change','decide') THEN
    PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
  ELSE
    PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(752991884322001::bigint);
  PERFORM ertad.review_identity(sid,token,op IN ('propose','change','decide'));
  IF op='contexts' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',o.id,'name',o.name) ORDER BY o.name,o.id),'[]') INTO result
      FROM ertad.organizations o WHERE o.status='active' AND EXISTS(SELECT 1 FROM ertad.units u
        WHERE u.organization_id=o.id AND ertad.review_has_scope(actor,o.id,u.id,'unit.read'));
  ELSIF op='units' THEN
    IF COALESCE(input->>'status','active') NOT IN ('active','archived') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid status'; END IF;
    page:=COALESCE((input->>'page')::integer,1);
    IF page NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid page'; END IF;
    WITH visible AS (SELECT u.id,u.name,u.kind,u.status,u.version,
      CASE WHEN ertad.review_has_scope(actor,org,u.parent_id,'unit.read') THEN u.parent_id ELSE NULL END AS parent_id,
      CASE WHEN ertad.review_has_scope(actor,org,u.parent_id,'unit.read') THEN (SELECT p.name FROM ertad.units p WHERE p.organization_id=org AND p.id=u.parent_id) ELSE NULL END AS parent_name,
      u.status='active' AND ertad.review_has_scope(actor,org,u.id,'unit.propose') AND u.kind='authority' AS "canPropose",
      u.kind='authority' AND ertad.review_has_scope(actor,org,u.parent_id,'unit.read')
       AND ertad.review_has_scope(actor,org,u.parent_id,'unit.change.propose') AS "canChange",
      CASE WHEN u.status='active' AND u.kind='authority' AND ertad.review_has_scope(actor,org,u.parent_id,'unit.read')
       AND ertad.review_has_scope(actor,org,u.parent_id,'unit.change.propose') THEN to_jsonb(ertad.unit_archive_blockers(org,u.id)) ELSE '[]'::jsonb END AS "archiveBlockers"
      FROM ertad.units u WHERE u.organization_id=org AND u.status=COALESCE(input->>'status','active')
      AND ((u.status='active' AND ertad.review_has_scope(actor,org,u.id,'unit.read'))
      OR (u.status='archived' AND ertad.review_has_scope(actor,org,u.parent_id,'unit.read')
        AND (ertad.review_has_scope(actor,org,u.parent_id,'unit.change.propose') OR ertad.review_has_scope(actor,org,u.parent_id,'unit.change.approve'))))
        AND position(lower(COALESCE(input->>'search','')) in lower(u.name))>0),
    paged AS (SELECT * FROM visible ORDER BY name,id LIMIT 25 OFFSET (page-1)*25)
    SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(to_jsonb(paged) ORDER BY name,id) FROM paged),'[]'),
      'total',(SELECT count(*) FROM visible),'page',page,'pageSize',25) INTO result;
  ELSIF op='propose' THEN
    parent:=(input->>'parentId')::uuid; expiry:=(input->>'expiresAt')::timestamptz;
    IF NOT ertad.review_has_scope(actor,org,parent,'unit.read') OR NOT ertad.review_has_scope(actor,org,parent,'unit.propose') THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
    SELECT * INTO r FROM ertad.unit_reviews WHERE organization_id=org AND requester_id=actor AND request_key=(input->>'key')::uuid;
    IF FOUND THEN
      IF r.kind<>'create' OR (r.parent_id,r.name,r.reason,r.expires_at) IS DISTINCT FROM (parent,trim(input->>'name'),trim(input->>'reason'),expiry) THEN
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request conflict'; END IF;
    ELSE
      IF NOT EXISTS(SELECT 1 FROM ertad.units WHERE organization_id=org AND id=parent AND kind='authority' AND status='active')
        OR expiry<=clock_timestamp() OR expiry>clock_timestamp()+interval '7 days' THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid parent or deadline'; END IF;
      INSERT INTO ertad.unit_reviews(organization_id,parent_id,parent_path,name,requester_id,reason,request_key,expires_at)
        VALUES(org,parent,ertad.unit_path(org,parent),trim(input->>'name'),actor,trim(input->>'reason'),(input->>'key')::uuid,expiry) RETURNING * INTO r;
      changed:=true;
    END IF;
    result:=jsonb_build_object('id',r.id,'status',r.status,'unitId',r.unit_id);
  ELSIF op='change' THEN
    change_kind:=input->>'kind'; expiry:=(input->>'expiresAt')::timestamptz;
    IF change_kind IS NULL OR change_kind NOT IN ('rename','archive','restore')
      OR (change_kind='rename' AND (input->>'name' IS NULL OR length(trim(input->>'name')) NOT BETWEEN 1 AND 160))
      OR (change_kind IN ('archive','restore') AND input ? 'name') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid change'; END IF;
    SELECT * INTO target FROM ertad.units WHERE organization_id=org AND id=(input->>'unitId')::uuid;
    IF NOT FOUND OR target.parent_id IS NULL OR target.kind<>'authority'
      OR NOT ertad.review_has_scope(actor,org,target.parent_id,'unit.read')
      OR NOT ertad.review_has_scope(actor,org,target.parent_id,'unit.change.propose') THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
    SELECT * INTO r FROM ertad.unit_reviews WHERE organization_id=org AND requester_id=actor AND request_key=(input->>'key')::uuid;
    IF FOUND THEN
      IF (r.kind,r.target_id,r.target_version,r.reason,r.expires_at) IS DISTINCT FROM
        (change_kind,target.id,(input->>'version')::integer,trim(input->>'reason'),expiry)
        OR (change_kind='rename' AND r.name IS DISTINCT FROM trim(input->>'name')) THEN
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request conflict'; END IF;
    ELSE
      IF target.status IS DISTINCT FROM (CASE WHEN change_kind='restore' THEN 'archived' ELSE 'active' END) OR target.version IS DISTINCT FROM (input->>'version')::integer
        OR (change_kind='rename' AND target.name=trim(input->>'name')) THEN
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Unit changed'; END IF;
      IF expiry<=clock_timestamp() OR expiry>clock_timestamp()+interval '7 days' THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid deadline'; END IF;
      IF change_kind='archive' AND cardinality(ertad.unit_archive_blockers(org,target.id))>0 THEN
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Unit has linked records'; END IF;
      INSERT INTO ertad.unit_reviews(organization_id,parent_id,parent_path,name,requester_id,reason,request_key,expires_at,kind,target_id,target_version,original_name)
      VALUES(org,target.parent_id,ertad.unit_path(org,target.parent_id),
        CASE WHEN change_kind='rename' THEN trim(input->>'name') ELSE target.name END,
        actor,trim(input->>'reason'),(input->>'key')::uuid,expiry,change_kind,target.id,target.version,target.name) RETURNING * INTO r;
      changed:=true;
    END IF;
    result:=jsonb_build_object('id',r.id,'status',r.status,'unitId',r.unit_id);
  ELSIF op IN ('detail','decide') THEN
    SELECT * INTO r FROM ertad.unit_reviews WHERE organization_id=org AND id=(input->>'id')::uuid;
    IF NOT FOUND OR NOT ertad.unit_review_visible(actor,r) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
    propose_permission:=CASE WHEN r.kind='create' THEN 'unit.propose' ELSE 'unit.change.propose' END;
    approve_permission:=CASE WHEN r.kind='create' THEN 'unit.approve' ELSE 'unit.change.approve' END;
    IF op='decide' THEN
      IF actor=r.requester_id OR NOT ertad.review_has_scope(actor,org,r.parent_id,approve_permission) THEN
        RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
      IF input->>'decision' NOT IN ('approved','rejected') OR length(trim(input->>'reason')) NOT BETWEEN 10 AND 1000 THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid decision'; END IF;
      IF r.status<>'pending' THEN
        IF (r.decision_by,r.decision_key,r.status,r.decision_reason) IS DISTINCT FROM (actor,(input->>'key')::uuid,input->>'decision',trim(input->>'reason')) THEN
          RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request conflict'; END IF;
      ELSE
        IF r.expires_at<=clock_timestamp() OR NOT ertad.review_has_scope(r.requester_id,org,r.parent_id,propose_permission)
          OR NOT EXISTS(SELECT 1 FROM ertad.units WHERE organization_id=org AND id=r.parent_id AND kind='authority')
          OR NOT ertad.review_has_scope(r.requester_id,org,r.parent_id,'unit.read')
          OR r.parent_path IS DISTINCT FROM ertad.unit_path(org,r.parent_id) THEN
          RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request conflict'; END IF;
        IF r.kind<>'create' THEN
          SELECT * INTO target FROM ertad.units WHERE organization_id=org AND id=r.target_id;
          IF NOT FOUND OR target.parent_id IS DISTINCT FROM r.parent_id OR target.version IS DISTINCT FROM r.target_version
            OR target.status IS DISTINCT FROM (CASE WHEN r.kind='restore' THEN 'archived' ELSE 'active' END) OR target.kind<>'authority' THEN
            RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Unit changed'; END IF;
        END IF;
        IF input->>'decision'='approved' THEN
          IF r.kind IN ('create','rename','restore') AND EXISTS(SELECT 1 FROM ertad.units WHERE organization_id=org AND parent_id=r.parent_id AND id IS DISTINCT FROM r.target_id AND status='active' AND lower(trim(name))=lower(r.name)) THEN
            RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Duplicate unit'; END IF;
          IF r.kind='create' THEN
            INSERT INTO ertad.units(organization_id,parent_id,name,kind) VALUES(org,r.parent_id,r.name,'authority') RETURNING id INTO new_unit;
          ELSE
            IF r.kind='archive' AND cardinality(ertad.unit_archive_blockers(org,r.target_id,r.id))>0 THEN
              RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Unit has linked records'; END IF;
            UPDATE ertad.units SET name=r.name,status=CASE WHEN r.kind='archive' THEN 'archived' ELSE 'active' END
              WHERE organization_id=org AND id=r.target_id RETURNING id INTO new_unit;
          END IF;
        END IF;
        UPDATE ertad.unit_reviews SET status=input->>'decision',decision_by=actor,decision_key=(input->>'key')::uuid,
          decision_reason=trim(input->>'reason'),decision_at=clock_timestamp(),unit_id=new_unit WHERE organization_id=org AND id=r.id RETURNING * INTO r;
        changed:=true;
      END IF;
      result:=jsonb_build_object('id',r.id,'status',r.status,'unitId',r.unit_id);
    ELSE
      result:=(to_jsonb(r)-ARRAY['request_key','decision_key','parent_path'])||jsonb_build_object('parent_name',
        (SELECT name FROM ertad.units WHERE organization_id=org AND id=r.parent_id),
        'status',CASE WHEN r.status='pending' AND r.expires_at<=clock_timestamp() THEN 'expired' ELSE r.status END,
        'canDecide',r.status='pending' AND r.expires_at>clock_timestamp() AND actor<>r.requester_id AND ertad.review_has_scope(actor,org,r.parent_id,approve_permission));
    END IF;
  ELSE
    page:=COALESCE((input->>'page')::integer,1);view_name:=COALESCE(input->>'view','pending');
    IF page NOT BETWEEN 1 AND 1000 OR view_name NOT IN ('pending','mine','history') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid filter'; END IF;
    WITH visible AS (SELECT r.id,r.name,r.kind,r.original_name,r.target_id,u.name AS parent_name,r.parent_id,r.created_at,r.expires_at,
      CASE WHEN r.status='pending' AND r.expires_at<=clock_timestamp() THEN 'expired' ELSE r.status END AS status
      FROM ertad.unit_reviews r JOIN ertad.units u ON (u.organization_id,u.id)=(r.organization_id,r.parent_id)
      WHERE r.organization_id=org AND ertad.unit_review_visible(actor,r)
      AND ((view_name='mine' AND r.requester_id=actor) OR (view_name='pending' AND r.requester_id<>actor AND r.status='pending' AND r.expires_at>clock_timestamp())
        OR (view_name='history' AND (r.status<>'pending' OR r.expires_at<=clock_timestamp())))),
    paged AS (SELECT * FROM visible ORDER BY expires_at,id LIMIT 25 OFFSET (page-1)*25)
    SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(to_jsonb(paged) ORDER BY expires_at,id) FROM paged),'[]'),
      'total',(SELECT count(*) FROM visible),'page',page,'pageSize',25) INTO result;
  END IF;
  RETURN jsonb_build_object('data',result,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'reviewId',r.id,'changed',changed));
END; $$;


CREATE OR REPLACE FUNCTION ertad.unit_review_finish(sid uuid,token text,org uuid,rid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid; r ertad.unit_reviews; target ertad.units;
BEGIN
 actor:=ertad.review_identity(sid,token,true);
 SELECT * INTO r FROM ertad.unit_reviews WHERE organization_id=org AND id=rid;
 IF NOT FOUND OR r.expires_at<=clock_timestamp() OR r.parent_path IS DISTINCT FROM ertad.unit_path(org,r.parent_id)
   OR NOT EXISTS(SELECT 1 FROM ertad.units WHERE organization_id=org AND id=r.parent_id AND kind='authority')
   OR NOT ertad.review_has_scope(r.requester_id,org,r.parent_id,CASE WHEN r.kind='create' THEN 'unit.propose' ELSE 'unit.change.propose' END)
   OR NOT ertad.review_has_scope(r.requester_id,org,r.parent_id,'unit.read')
   OR NOT ertad.review_has_scope(actor,org,r.parent_id,'unit.read')
   OR NOT ((r.status='pending' AND r.requester_id=actor) OR (r.status<>'pending' AND r.decision_by=actor
     AND ertad.review_has_scope(actor,org,r.parent_id,CASE WHEN r.kind='create' THEN 'unit.approve' ELSE 'unit.change.approve' END))) THEN
   RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request conflict'; END IF;
 IF r.kind<>'create' THEN
   SELECT * INTO target FROM ertad.units WHERE organization_id=org AND id=r.target_id;
   IF NOT FOUND OR target.parent_id IS DISTINCT FROM r.parent_id OR target.kind<>'authority'
     OR target.version IS DISTINCT FROM (r.target_version+CASE WHEN r.status='approved' THEN 1 ELSE 0 END)
     OR target.name IS DISTINCT FROM (CASE WHEN r.status='approved' THEN r.name ELSE r.original_name END)
     OR target.status IS DISTINCT FROM (CASE WHEN (r.status='approved' AND r.kind='archive') OR (r.status<>'approved' AND r.kind='restore') THEN 'archived' ELSE 'active' END) THEN
     RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Unit changed'; END IF;
   IF r.kind='archive' AND r.status IN ('pending','approved') AND cardinality(ertad.unit_archive_blockers(org,r.target_id,r.id))>0 THEN
     RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Unit has linked records'; END IF;
 END IF;
END; $$;

REVOKE ALL ON FUNCTION ertad.unit_version(),ertad.unit_archive_blockers(uuid,uuid,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION ertad.inbox_workflow_entries(actor uuid,org uuid) RETURNS TABLE(
 source text,id uuid,version integer,unit_id uuid,title text,status text,updated_at timestamptz,deadline timestamptz,unread boolean,action text
) LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT 'membership',r.id,CASE WHEN r.status='pending' THEN 1 ELSE 2 END,r.unit_id,p.name,
  CASE WHEN r.status='pending' AND r.expires_at<=clock_timestamp() THEN 'expired' ELSE r.status END,
  COALESCE(r.decision_at,r.created_at),r.expires_at,
  CASE WHEN n.review_id IS NOT NULL THEN n.read_at IS NULL ELSE COALESCE(m.read_version,0)<CASE WHEN r.status='pending' THEN 1 ELSE 2 END END,
  CASE WHEN r.status='pending' AND r.expires_at>clock_timestamp() AND actor NOT IN(r.requester_id,r.target_id) AND ertad.review_has_scope(actor,org,r.unit_id,'membership.approve') THEN 'review' ELSE '' END
 FROM ertad.membership_reviews r JOIN ertad.positions p ON p.organization_id=r.organization_id AND p.id=r.position_id
 LEFT JOIN ertad.review_notifications n ON n.organization_id=r.organization_id AND n.review_id=r.id AND n.recipient_id=actor
 LEFT JOIN ertad.membership_inbox_reads m ON m.organization_id=r.organization_id AND m.review_id=r.id AND m.recipient_id=actor
 WHERE r.organization_id=org AND ertad.review_visible(actor,r) AND (r.status='pending' OR actor IN(r.requester_id,r.decision_by) OR n.review_id IS NOT NULL)
 UNION ALL
 SELECT 'unit',r.id,CASE WHEN r.status='pending' THEN 1 ELSE 2 END,r.parent_id,r.name,
  CASE WHEN r.status='pending' AND r.expires_at<=clock_timestamp() THEN 'expired' ELSE r.status END,
  COALESCE(r.decision_at,r.created_at),r.expires_at,COALESCE(m.read_version,0)<CASE WHEN r.status='pending' THEN 1 ELSE 2 END,
  CASE WHEN r.status='pending' AND r.expires_at>clock_timestamp() AND actor<>r.requester_id AND r.parent_path=ertad.unit_path(org,r.parent_id) AND ertad.review_has_scope(actor,org,r.parent_id,CASE WHEN r.kind='create' THEN 'unit.approve' ELSE 'unit.change.approve' END) THEN 'review' ELSE '' END
 FROM ertad.unit_reviews r LEFT JOIN ertad.unit_inbox_reads m ON m.organization_id=r.organization_id AND m.review_id=r.id AND m.recipient_id=actor
 WHERE r.organization_id=org AND ertad.unit_review_visible(actor,r) AND (r.status='pending' OR actor IN(r.requester_id,r.decision_by))
 UNION ALL
 SELECT 'work',w.id,w.version,w.unit_id,w.title,w.status,
  COALESCE((SELECT max(e.created_at) FROM ertad.work_events e WHERE e.organization_id=org AND e.work_id=w.id),w.created_at),w.deadline,
  EXISTS(SELECT 1 FROM ertad.work_notifications n WHERE n.organization_id=org AND n.work_id=w.id AND n.recipient_id=actor AND n.read_at IS NULL),ertad.inbox_work_action(actor,w)
 FROM ertad.work_items w WHERE w.organization_id=org AND ertad.work_visible(actor,w) AND (
  w.creator_id=actor OR ertad.inbox_work_action(actor,w)<>'' OR EXISTS(SELECT 1 FROM ertad.work_notifications n WHERE n.organization_id=org AND n.work_id=w.id AND n.recipient_id=actor)
 )
 UNION ALL
 SELECT 'collective',p.id,p.version,p.unit_id,p.kind,
  CASE WHEN p.status='pending' AND p.deadline<=clock_timestamp() THEN 'expired' ELSE p.status END,
  greatest(p.created_at,COALESCE((SELECT max(v.created_at) FROM ertad.collective_votes v WHERE v.organization_id=org AND v.proposal_id=p.id),p.created_at)),p.deadline,n.read_version<p.version,
  CASE WHEN p.status='pending' AND p.deadline>clock_timestamp() AND actor=ANY(p.eligible_ids) AND ertad.collective_actor(actor,org,p.unit_id,p.kind,true) AND NOT EXISTS(SELECT 1 FROM ertad.collective_votes v WHERE v.organization_id=org AND v.proposal_id=p.id AND v.actor_id=actor) THEN 'review' ELSE '' END
 FROM ertad.collective_proposals p JOIN ertad.collective_notifications n ON n.organization_id=p.organization_id AND n.proposal_id=p.id AND n.recipient_id=actor
 WHERE p.organization_id=org AND ertad.collective_visible(actor,p)
$$;
