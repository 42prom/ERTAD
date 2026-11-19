-- A projection of existing domain records, not a second workflow or message store.
CREATE TABLE ertad.membership_inbox_reads (
 organization_id uuid NOT NULL,review_id uuid NOT NULL,recipient_id uuid NOT NULL REFERENCES ertad.member_users(id),
 read_version integer NOT NULL CHECK(read_version BETWEEN 1 AND 2),
 PRIMARY KEY(organization_id,review_id,recipient_id),
 FOREIGN KEY(organization_id,review_id) REFERENCES ertad.membership_reviews(organization_id,id)
);
CREATE TABLE ertad.unit_inbox_reads (
 organization_id uuid NOT NULL,review_id uuid NOT NULL,recipient_id uuid NOT NULL REFERENCES ertad.member_users(id),
 read_version integer NOT NULL CHECK(read_version BETWEEN 1 AND 2),
 PRIMARY KEY(organization_id,review_id,recipient_id),
 FOREIGN KEY(organization_id,review_id) REFERENCES ertad.unit_reviews(organization_id,id)
);
CREATE INDEX work_notification_recipient ON ertad.work_notifications(organization_id,recipient_id,work_id,version) INCLUDE(read_at);
CREATE INDEX collective_notification_recipient ON ertad.collective_notifications(organization_id,recipient_id,proposal_id) INCLUDE(read_version);

CREATE FUNCTION ertad.inbox_work_action(actor uuid,w ertad.work_items) RETURNS text
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
BEGIN
 IF w.status='offered' AND ertad.work_manager(actor,w) THEN RETURN 'accept'; END IF;
 IF w.status<>'open' THEN RETURN ''; END IF;
 IF ertad.review_has_scope(actor,w.organization_id,w.unit_id,'workitem.verify') AND (
  EXISTS(SELECT 1 FROM ertad.work_assignments WHERE organization_id=w.organization_id AND work_id=w.id AND status='submitted' AND user_id<>actor)
  OR EXISTS(SELECT 1 FROM ertad.work_criteria WHERE organization_id=w.organization_id AND work_id=w.id AND status='submitted' AND submitted_by<>actor)
 ) THEN RETURN 'verify'; END IF;
 IF ertad.review_has_scope(actor,w.organization_id,w.unit_id,'qualification.verify') AND EXISTS(
  SELECT 1 FROM ertad.qualification_claims WHERE organization_id=w.organization_id AND work_id=w.id AND status='pending' AND user_id<>actor AND ertad.work_visible(user_id,w)
 ) THEN RETURN 'qualification'; END IF;
 IF ertad.review_has_scope(actor,w.organization_id,w.unit_id,'workitem.verify') AND EXISTS(
  SELECT 1 FROM ertad.work_provisions p JOIN ertad.work_needs n ON n.organization_id=p.organization_id AND n.id=p.need_id
  WHERE n.organization_id=w.organization_id AND n.work_id=w.id AND NOT n.cancelled AND p.status='pledged' AND p.user_id<>actor AND ertad.work_visible(p.user_id,w)
 ) THEN RETURN 'receive'; END IF;
 IF ertad.work_manager(actor,w) AND EXISTS(SELECT 1 FROM ertad.work_assignments WHERE organization_id=w.organization_id AND work_id=w.id AND status IN ('applied','reserved')) THEN RETURN 'assign'; END IF;
 IF ertad.review_has_scope(actor,w.organization_id,w.unit_id,'workitem.participate') AND EXISTS(
  SELECT 1 FROM ertad.work_assignments WHERE organization_id=w.organization_id AND work_id=w.id AND user_id=actor AND status IN ('assigned','in_progress')
 ) THEN RETURN 'participate'; END IF;
 IF ertad.work_manager(actor,w) AND ((w.coordinator_id=actor AND w.deadline<=clock_timestamp()) OR EXISTS(
  SELECT 1 FROM ertad.work_blockers WHERE organization_id=w.organization_id AND work_id=w.id AND owner_id=actor AND resolved_at IS NULL
 )) THEN RETURN 'follow_up'; END IF;
 RETURN '';
END $$;

CREATE FUNCTION ertad.inbox_entries(actor uuid,org uuid) RETURNS TABLE(
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
  CASE WHEN r.status='pending' AND r.expires_at>clock_timestamp() AND actor<>r.requester_id AND r.parent_path=ertad.unit_path(org,r.parent_id) AND ertad.review_has_scope(actor,org,r.parent_id,'unit.approve') THEN 'review' ELSE '' END
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

CREATE FUNCTION ertad.inbox_contexts(actor uuid) RETURNS TABLE(id uuid,name text)
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT o.id,o.name FROM ertad.organizations o WHERE o.status='active' AND EXISTS(
  SELECT 1 FROM ertad.units u WHERE u.organization_id=o.id AND (
   ertad.review_has_scope(actor,o.id,u.id,'unit.read') OR ertad.review_has_scope(actor,o.id,u.id,'workitem.read')
   OR ertad.review_has_scope(actor,o.id,u.id,'membership.propose') OR ertad.review_has_scope(actor,o.id,u.id,'membership.approve')
   OR ertad.review_has_scope(actor,o.id,u.id,'governance.propose') OR ertad.review_has_scope(actor,o.id,u.id,'governance.vote')
  )
 )
$$;

CREATE FUNCTION ertad.inbox_command(sid uuid,token text,op text,org uuid,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid; result jsonb; item record; requested integer; page integer; view_name text; source_name text;
BEGIN
 IF op NOT IN ('summary','list','read') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid inbox operation'; END IF;
 actor:=ertad.review_identity(sid,token,false);
 IF op='summary' THEN
  PERFORM 1 FROM ertad.organizations o WHERE EXISTS(SELECT 1 FROM ertad.memberships m WHERE m.organization_id=o.id AND m.user_id=actor) ORDER BY o.id FOR SHARE;
 ELSIF op='read' THEN PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR UPDATE;
 ELSE PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR SHARE; END IF;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint); PERFORM ertad.review_identity(sid,token,false);
 IF op<>'summary' AND NOT EXISTS(SELECT 1 FROM ertad.inbox_contexts(actor) c WHERE c.id=org) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Inbox unavailable'; END IF;
 IF op='summary' THEN
  WITH contexts AS MATERIALIZED(SELECT * FROM ertad.inbox_contexts(actor)), entries AS MATERIALIZED(SELECT e.* FROM contexts c CROSS JOIN LATERAL ertad.inbox_entries(actor,c.id) e)
  SELECT jsonb_build_object('contexts',COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.name,c.id) FROM contexts c),'[]'),
   'unread',(SELECT count(*) FROM entries WHERE unread),'actionRequired',(SELECT count(*) FROM entries WHERE action<>'')) INTO result;
 ELSIF op='list' THEN
  page:=COALESCE((input->>'page')::int,1);view_name:=COALESCE(input->>'view','action');source_name:=COALESCE(input->>'source','all');
  IF page NOT BETWEEN 1 AND 1000 OR view_name NOT IN ('all','unread','action') OR source_name NOT IN ('all','membership','unit','work','collective') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid inbox filter'; END IF;
  WITH visible AS MATERIALIZED(SELECT * FROM ertad.inbox_entries(actor,org) e WHERE (source_name='all' OR e.source=source_name)),
  filtered AS(SELECT * FROM visible WHERE CASE view_name WHEN 'unread' THEN unread WHEN 'action' THEN action<>'' ELSE true END),
  paged AS(SELECT * FROM filtered ORDER BY updated_at DESC,source,id LIMIT 25 OFFSET (page-1)*25)
  SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(jsonb_build_object('source',p.source,'id',p.id,'version',p.version,'unitId',p.unit_id,
   'unitName',CASE WHEN ertad.review_has_scope(actor,org,p.unit_id,'unit.read') THEN (SELECT name FROM ertad.units WHERE organization_id=org AND id=p.unit_id) END,
   'title',p.title,'status',p.status,'updatedAt',p.updated_at,'deadline',p.deadline,'unread',p.unread,'action',p.action) ORDER BY p.updated_at DESC,p.source,p.id) FROM paged p),'[]'),
   'total',(SELECT count(*) FROM filtered),'unread',(SELECT count(*) FROM visible WHERE unread),'actionRequired',(SELECT count(*) FROM visible WHERE action<>''),'page',page,'pageSize',25) INTO result;
 ELSE
  SELECT * INTO item FROM ertad.inbox_entries(actor,org) e WHERE e.source=input->>'source' AND e.id=(input->>'id')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Inbox item unavailable'; END IF;
  requested:=(input->>'version')::int;
  IF requested IS NULL OR requested<1 OR requested>item.version THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Observed version required'; END IF;
  IF item.source='membership' THEN
   INSERT INTO ertad.membership_inbox_reads VALUES(org,item.id,actor,requested) ON CONFLICT(organization_id,review_id,recipient_id) DO UPDATE SET read_version=greatest(membership_inbox_reads.read_version,excluded.read_version);
   IF requested>=item.version THEN UPDATE ertad.review_notifications SET read_at=COALESCE(read_at,clock_timestamp()) WHERE organization_id=org AND review_id=item.id AND recipient_id=actor; END IF;
  ELSIF item.source='unit' THEN
   INSERT INTO ertad.unit_inbox_reads VALUES(org,item.id,actor,requested) ON CONFLICT(organization_id,review_id,recipient_id) DO UPDATE SET read_version=greatest(unit_inbox_reads.read_version,excluded.read_version);
  ELSIF item.source='work' THEN UPDATE ertad.work_notifications SET read_at=COALESCE(read_at,clock_timestamp()) WHERE organization_id=org AND work_id=item.id AND recipient_id=actor AND version<=requested;
  ELSE UPDATE ertad.collective_notifications SET read_version=greatest(read_version,requested) WHERE organization_id=org AND proposal_id=item.id AND recipient_id=actor; END IF;
  result:=jsonb_build_object('id',item.id,'version',requested);
 END IF;
 RETURN jsonb_build_object('data',result,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'source',input->>'source','recordId',input->>'id'));
END $$;
REVOKE ALL ON ertad.membership_inbox_reads,ertad.unit_inbox_reads FROM PUBLIC,ertad_app;
REVOKE ALL ON FUNCTION ertad.inbox_work_action(uuid,ertad.work_items),ertad.inbox_entries(uuid,uuid),ertad.inbox_contexts(uuid),ertad.inbox_command(uuid,text,text,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.inbox_command(uuid,text,text,uuid,jsonb) TO ertad_app;
