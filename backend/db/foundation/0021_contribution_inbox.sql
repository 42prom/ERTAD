-- Recipient notices project the immutable ledger; they never disclose approval deliberations.
CREATE TABLE ertad.contribution_inbox_reads (
 organization_id uuid NOT NULL,entry_id uuid NOT NULL,recipient_id uuid NOT NULL REFERENCES ertad.member_users(id),
 PRIMARY KEY(organization_id,entry_id,recipient_id),
 FOREIGN KEY(organization_id,entry_id) REFERENCES ertad.contribution_entries(organization_id,id)
);
REVOKE ALL ON ertad.contribution_inbox_reads FROM PUBLIC,ertad_app;
ALTER FUNCTION ertad.inbox_entries(uuid,uuid) RENAME TO inbox_prior_contribution_entries;
CREATE FUNCTION ertad.inbox_entries(actor uuid,org uuid) RETURNS TABLE(
 source text,id uuid,version integer,unit_id uuid,title text,status text,updated_at timestamptz,deadline timestamptz,unread boolean,action text
) LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT * FROM ertad.inbox_prior_contribution_entries(actor,org)
 UNION ALL
 SELECT 'contribution',e.id,1,e.unit_id,'contribution_record',e.kind,
  e.earned_on::timestamp AT TIME ZONE 'UTC',NULL,rd.entry_id IS NULL,''
 FROM ertad.contribution_entries e
 LEFT JOIN ertad.contribution_inbox_reads rd ON rd.organization_id=e.organization_id AND rd.entry_id=e.id AND rd.recipient_id=actor
 WHERE e.organization_id=org AND e.user_id=actor AND EXISTS(
  SELECT 1 FROM ertad.units u WHERE u.organization_id=org AND ertad.review_has_scope(actor,org,u.id,'unit.read'))
$$;
REVOKE ALL ON FUNCTION ertad.inbox_entries(uuid,uuid) FROM PUBLIC,ertad_app;

-- Exact recipient lookup retains the original own-history authority and balance.
-- No source IDs, issuer IDs, precise event times or approval text are added.
ALTER FUNCTION ertad.contribution_view(uuid,uuid,jsonb) RENAME TO contribution_history_view;
CREATE FUNCTION ertad.contribution_view(actor uuid,org uuid,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE result jsonb;e ertad.contribution_entries;
BEGIN
 IF NOT input ? 'entryId' THEN RETURN ertad.contribution_history_view(actor,org,input); END IF;
 IF input ? 'memberId' OR input ? 'unitId' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Recipient lookup required'; END IF;
 result:=ertad.contribution_history_view(actor,org,'{}');
 SELECT * INTO e FROM ertad.contribution_entries WHERE organization_id=org AND id=(input->>'entryId')::uuid AND user_id=actor;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Recognition unavailable'; END IF;
 RETURN result||jsonb_build_object('total',1,'page',1,'entries',jsonb_build_array(jsonb_build_object(
  'id',e.id,'kind',e.kind,'category',e.category,'points',e.points,'unitId',e.unit_id,'reason',e.reason,'date',e.earned_on,'reversesId',e.reverses_id)));
END $$;
REVOKE ALL ON FUNCTION ertad.contribution_view(uuid,uuid,jsonb),ertad.contribution_history_view(uuid,uuid,jsonb) FROM PUBLIC,ertad_app;

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
  IF page NOT BETWEEN 1 AND 1000 OR view_name NOT IN ('all','unread','action') OR source_name NOT IN ('all','membership','unit','work','collective','decision','moderation','contribution') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid inbox filter'; END IF;
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
  ELSIF item.source='contribution' THEN
   INSERT INTO ertad.contribution_inbox_reads VALUES(org,item.id,actor) ON CONFLICT DO NOTHING;
  ELSIF item.source='moderation' THEN
   INSERT INTO ertad.moderation_inbox_reads VALUES(org,item.id,actor,requested) ON CONFLICT(organization_id,restriction_id,recipient_id) DO UPDATE SET read_version=greatest(moderation_inbox_reads.read_version,excluded.read_version);
  ELSIF item.source='decision' THEN
   INSERT INTO ertad.decision_inbox_reads VALUES(org,item.id,actor,requested) ON CONFLICT(organization_id,decision_id,recipient_id) DO UPDATE SET read_version=greatest(decision_inbox_reads.read_version,excluded.read_version);
  ELSE UPDATE ertad.collective_notifications SET read_version=greatest(read_version,requested) WHERE organization_id=org AND proposal_id=item.id AND recipient_id=actor; END IF;
  result:=jsonb_build_object('id',item.id,'version',requested);
 END IF;
 RETURN jsonb_build_object('data',result,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'source',input->>'source','recordId',input->>'id'));
END $$;
