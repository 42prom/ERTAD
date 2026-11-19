-- Published Decision notices reuse the current electorate and domain permissions.
-- No ballot, answer, participant directory or result is copied into Communication.
CREATE TABLE ertad.decision_inbox_reads (
 organization_id uuid NOT NULL,decision_id uuid NOT NULL,recipient_id uuid NOT NULL REFERENCES ertad.member_users(id),
 read_version integer NOT NULL CHECK(read_version BETWEEN 1 AND 4),
 PRIMARY KEY(organization_id,decision_id,recipient_id),
 FOREIGN KEY(organization_id,decision_id) REFERENCES ertad.decisions(organization_id,id)
);
CREATE INDEX decision_electorate_recipient ON ertad.decision_electorate(organization_id,user_id,decision_id);

ALTER FUNCTION ertad.inbox_entries(uuid,uuid) RENAME TO inbox_workflow_entries;
ALTER FUNCTION ertad.inbox_contexts(uuid) RENAME TO inbox_workflow_contexts;

CREATE FUNCTION ertad.inbox_entries(actor uuid,org uuid) RETURNS TABLE(
 source text,id uuid,version integer,unit_id uuid,title text,status text,updated_at timestamptz,deadline timestamptz,unread boolean,action text
) LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT * FROM ertad.inbox_workflow_entries(actor,org)
 UNION ALL
 SELECT 'decision',d.id,n.version,d.unit_id,d.title,
  CASE WHEN d.status='open' AND d.closes_at<=clock_timestamp() THEN 'closed' ELSE d.status END,
  CASE WHEN d.status IN ('closed','cancelled') THEN d.closed_at
       WHEN d.closes_at<=clock_timestamp() THEN d.closes_at ELSE d.opened_at END,d.closes_at,
  COALESCE(r.read_version,0)<n.version,
  CASE WHEN d.status='open' AND d.closes_at>clock_timestamp() AND e.eligible AND
    CASE WHEN d.kind='survey' THEN NOT EXISTS(SELECT 1 FROM ertad.decision_survey_responses v WHERE v.organization_id=org AND v.decision_id=d.id AND v.user_id=actor)
    ELSE NOT EXISTS(SELECT 1 FROM ertad.decision_named_votes v WHERE v.organization_id=org AND v.decision_id=d.id AND v.user_id=actor) END
   THEN 'decision_participate' ELSE '' END
 FROM ertad.decisions d
 CROSS JOIN LATERAL(SELECT EXISTS(SELECT 1 FROM ertad.decision_electorate e
  WHERE e.organization_id=org AND e.decision_id=d.id AND e.user_id=actor
   AND ertad.decision_eligible(actor,org,d.unit_id,e.membership_id)) eligible) e
 -- Notice lifecycle is independent of votes and unpublished draft edit versions.
 CROSS JOIN LATERAL(SELECT CASE WHEN d.status='cancelled' THEN 4 WHEN d.status='closed' THEN 3
  WHEN d.closes_at<=clock_timestamp() THEN 2 ELSE 1 END version) n
 LEFT JOIN ertad.decision_inbox_reads r ON r.organization_id=org AND r.decision_id=d.id AND r.recipient_id=actor
 WHERE d.organization_id=org AND d.privacy='named' AND d.opened_at IS NOT NULL AND d.status<>'draft'
  AND d.scope_path=ertad.unit_path(org,d.unit_id) AND ertad.decision_visible(actor,d)
  AND (e.eligible OR d.creator_id=actor OR ertad.review_has_scope(actor,org,d.unit_id,'decision.manage')
   OR ertad.review_has_scope(actor,org,d.unit_id,'decision.publish'))
$$;

CREATE FUNCTION ertad.inbox_contexts(actor uuid) RETURNS TABLE(id uuid,name text)
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT * FROM ertad.inbox_workflow_contexts(actor)
 UNION
 SELECT o.id,o.name FROM ertad.organizations o WHERE o.status='active' AND EXISTS(
  SELECT 1 FROM ertad.units u WHERE u.organization_id=o.id AND
   (ertad.review_has_scope(actor,o.id,u.id,'decision.read') OR ertad.review_has_scope(actor,o.id,u.id,'decision.vote')))
$$;

REVOKE ALL ON ertad.decision_inbox_reads FROM PUBLIC,ertad_app;
REVOKE ALL ON FUNCTION ertad.inbox_entries(uuid,uuid),ertad.inbox_contexts(uuid) FROM PUBLIC,ertad_app;

CREATE OR REPLACE FUNCTION ertad.inbox_command(sid uuid,token text,op text,org uuid,input jsonb) RETURNS jsonb
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
  IF page NOT BETWEEN 1 AND 1000 OR view_name NOT IN ('all','unread','action') OR source_name NOT IN ('all','membership','unit','work','collective','decision') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid inbox filter'; END IF;
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
  ELSIF item.source='decision' THEN
   INSERT INTO ertad.decision_inbox_reads VALUES(org,item.id,actor,requested) ON CONFLICT(organization_id,decision_id,recipient_id) DO UPDATE SET read_version=greatest(decision_inbox_reads.read_version,excluded.read_version);
  ELSE UPDATE ertad.collective_notifications SET read_version=greatest(read_version,requested) WHERE organization_id=org AND proposal_id=item.id AND recipient_id=actor; END IF;
  result:=jsonb_build_object('id',item.id,'version',requested);
 END IF;
 RETURN jsonb_build_object('data',result,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'source',input->>'source','recordId',input->>'id'));
END $$;
