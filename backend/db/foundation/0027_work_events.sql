-- One event is one canonical participation occurrence. Staffing stays in Work.
CREATE TABLE ertad.mobilization_events (
 organization_id uuid NOT NULL REFERENCES ertad.organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 unit_id uuid NOT NULL, creator_id uuid NOT NULL REFERENCES ertad.member_users(id),
 title text NOT NULL CHECK(length(trim(title)) BETWEEN 3 AND 160),
 description text NOT NULL CHECK(length(description)<=3000), location text NOT NULL CHECK(length(location)<=300),
 starts_at timestamptz NOT NULL CHECK(isfinite(starts_at)), ends_at timestamptz NOT NULL CHECK(isfinite(ends_at)),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed','cancelled')),
 scope_path uuid[] NOT NULL, contribution_rule_id uuid, version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), CHECK(ends_at>starts_at),
 PRIMARY KEY(organization_id,id), FOREIGN KEY(organization_id,unit_id) REFERENCES ertad.units(organization_id,id),
 FOREIGN KEY(organization_id,contribution_rule_id) REFERENCES ertad.contribution_rules(organization_id,id)
);
CREATE INDEX mobilization_event_queue ON ertad.mobilization_events(organization_id,status,starts_at,id);
ALTER TABLE ertad.work_items ADD COLUMN event_id uuid;
ALTER TABLE ertad.work_items ADD FOREIGN KEY(organization_id,event_id) REFERENCES ertad.mobilization_events(organization_id,id);
CREATE INDEX work_event_tasks ON ertad.work_items(organization_id,event_id);
CREATE TABLE ertad.event_commands (
 organization_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES ertad.member_users(id), key uuid NOT NULL,
 event_id uuid NOT NULL, operation text NOT NULL, fingerprint text NOT NULL, response jsonb NOT NULL,
 PRIMARY KEY(organization_id,actor_id,key), FOREIGN KEY(organization_id,event_id) REFERENCES ertad.mobilization_events(organization_id,id)
);
CREATE TABLE ertad.event_participation_claims (
 organization_id uuid NOT NULL, event_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES ertad.member_users(id),
 activity_id uuid NOT NULL, PRIMARY KEY(organization_id,event_id,user_id),
 FOREIGN KEY(organization_id,event_id) REFERENCES ertad.mobilization_events(organization_id,id),
 FOREIGN KEY(organization_id,activity_id) REFERENCES ertad.activity_entries(organization_id,id)
);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['event_commands','event_participation_claims'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON ertad.%I FOR EACH ROW EXECUTE FUNCTION ertad.prevent_audit_log_mutation()',tab);
  EXECUTE format('CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON ertad.%I FOR EACH STATEMENT EXECUTE FUNCTION ertad.prevent_audit_log_mutation()',tab);
 END LOOP;
END $$;

CREATE FUNCTION ertad.event_manager(actor uuid,e ertad.mobilization_events) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT e.scope_path=ertad.unit_path(e.organization_id,e.unit_id)
 AND ertad.review_has_scope(actor,e.organization_id,e.unit_id,'workitem.read')
 AND ertad.review_has_scope(actor,e.organization_id,e.unit_id,'workitem.create')
$$;
CREATE FUNCTION ertad.event_visible(actor uuid,e ertad.mobilization_events) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT e.scope_path=ertad.unit_path(e.organization_id,e.unit_id) AND (
 ertad.review_has_scope(actor,e.organization_id,e.unit_id,'workitem.read') OR EXISTS(
 SELECT 1 FROM ertad.work_items w WHERE w.organization_id=e.organization_id AND w.event_id=e.id AND ertad.work_visible(actor,w)))
$$;
CREATE FUNCTION ertad.event_view(actor uuid,e ertad.mobilization_events) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',e.id,'unitId',e.unit_id,'title',e.title,'description',e.description,
 'startsAt',e.starts_at,'endsAt',e.ends_at,'location',e.location,'status',e.status,'version',e.version,
 'canManage',ertad.event_manager(actor,e),'rewardPolicy','once_per_event',
 'contributionOffer',(SELECT jsonb_build_object('ruleId',r.id,'title',r.template_title,'amount',r.amount,
 'memberMonthCap',r.member_month_cap,'ruleVersion',r.version) FROM ertad.contribution_rules r WHERE r.organization_id=e.organization_id AND r.id=e.contribution_rule_id))
$$;

-- Every verified assignment still creates Activity. Only the first confirmed
-- occurrence can use the pinned event offer, including when its cap is exhausted.
CREATE OR REPLACE FUNCTION ertad.contribution_from_activity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE w ertad.work_items; claimed uuid;
BEGIN
 SELECT wi.* INTO w FROM ertad.work_items wi JOIN ertad.work_assignments a ON a.organization_id=wi.organization_id AND a.work_id=wi.id WHERE a.organization_id=NEW.organization_id AND a.id=NEW.assignment_id;
 IF w.event_id IS NOT NULL THEN
  INSERT INTO ertad.event_participation_claims(organization_id,event_id,user_id,activity_id)
  VALUES(NEW.organization_id,w.event_id,NEW.user_id,NEW.id) ON CONFLICT DO NOTHING RETURNING activity_id INTO claimed;
  IF claimed IS NULL THEN RETURN NEW; END IF;
 END IF;
 PERFORM ertad.contribution_issue(NEW.organization_id,NEW.unit_id,NEW.user_id,w.contribution_rule_id,'activity',NEW.id,NEW.verifier_id,NULL,'');
 RETURN NEW;
END $$;

ALTER FUNCTION ertad.work_command(uuid,text,text,uuid,jsonb) RENAME TO work_before_events_command;
CREATE FUNCTION ertad.work_command(sid uuid,token text,op text,org uuid,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_column
DECLARE actor uuid; e ertad.mobilization_events; w ertad.work_items; parent ertad.work_items;
 r ertad.contribution_rules; receipt ertad.event_commands; result jsonb; data jsonb; tasks jsonb;
 mutation boolean; changed boolean:=false; fp text; page_number integer; event uuid;
BEGIN
 IF op NOT IN ('event_list','event_detail','event_create','event_complete','event_cancel') THEN
  -- Let the existing command own locking, scope, receipts, capacity and lifecycle.
  result:=ertad.work_before_events_command(sid,token,op,org,
   CASE WHEN op='create' AND input ? 'eventId' THEN input||jsonb_build_object('contributionRuleId',NULL) ELSE input END);
  actor:=ertad.review_identity(sid,token,op IN ('create','delegate'));
  IF op IN ('create','delegate') THEN
   SELECT * INTO w FROM ertad.work_items WHERE organization_id=org AND id=(result->'data'->>'id')::uuid;
   IF op='delegate' THEN
    SELECT * INTO parent FROM ertad.work_items WHERE organization_id=org AND id=w.parent_id;
    event:=parent.event_id;
   ELSE event:=(input->>'eventId')::uuid;
   END IF;
   IF event IS NOT NULL THEN
    SELECT * INTO e FROM ertad.mobilization_events WHERE organization_id=org AND id=event;
    IF NOT FOUND OR NOT ertad.event_visible(actor,e) OR (op='create' AND NOT ertad.event_manager(actor,e))
     OR NOT e.unit_id=ANY(w.scope_path) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Event unavailable'; END IF;
    IF input ? 'contributionRuleId' AND (input->>'contributionRuleId')::uuid IS DISTINCT FROM e.contribution_rule_id THEN
     RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Event reward is pinned'; END IF;
    IF (result->'audit'->>'changed')::boolean THEN
     IF e.status<>'open' OR e.ends_at<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Event closed'; END IF;
     IF (SELECT count(*) FROM ertad.work_items WHERE organization_id=org AND event_id=event)>=100 THEN
      RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Event task limit'; END IF;
     UPDATE ertad.work_items SET event_id=event,contribution_rule_id=e.contribution_rule_id WHERE organization_id=org AND id=w.id;
    ELSIF w.event_id IS DISTINCT FROM event THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Retry conflict'; END IF;
   END IF;
  ELSIF op='detail' THEN
   SELECT * INTO w FROM ertad.work_items WHERE organization_id=org AND id=(input->>'id')::uuid;
   SELECT * INTO e FROM ertad.mobilization_events WHERE organization_id=org AND id=w.event_id;
   IF FOUND AND ertad.event_visible(actor,e) THEN
    result:=jsonb_set(result,'{data}',(result->'data')||jsonb_build_object('event',ertad.event_view(actor,e)));
   END IF;
  END IF;
  RETURN result;
 END IF;
 mutation:=op NOT IN ('event_list','event_detail');
 actor:=ertad.review_identity(sid,token,mutation);
 IF mutation THEN PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR UPDATE;
 ELSE PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR SHARE; END IF;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint);
 PERFORM ertad.review_identity(sid,token,mutation);
 IF op='event_list' THEN
  page_number:=COALESCE((input->>'page')::integer,1);
  IF page_number NOT BETWEEN 1 AND 1000 OR COALESCE(input->>'status','open') NOT IN ('open','completed','cancelled')
   OR length(COALESCE(input->>'search',''))>80 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid filter'; END IF;
  WITH visible AS (SELECT e.* FROM ertad.mobilization_events e WHERE e.organization_id=org AND ertad.event_visible(actor,e)
   AND e.status=COALESCE(input->>'status','open') AND position(lower(COALESCE(input->>'search','')) IN lower(e.title))>0),
  paged AS (SELECT * FROM visible ORDER BY starts_at,id LIMIT 25 OFFSET (page_number-1)*25)
  SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(ertad.event_view(actor,paged::ertad.mobilization_events) ORDER BY starts_at,id) FROM paged),'[]'),
   'total',(SELECT count(*) FROM visible),'page',page_number,'pageSize',25) INTO data;
 ELSE
  IF op='event_create' THEN
   IF NOT ertad.review_has_scope(actor,org,(input->>'unitId')::uuid,'workitem.create') OR NOT ertad.review_has_scope(actor,org,(input->>'unitId')::uuid,'workitem.read') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
  ELSE
   SELECT * INTO e FROM ertad.mobilization_events WHERE organization_id=org AND id=(input->>'id')::uuid;
   IF NOT FOUND OR NOT ertad.event_visible(actor,e) OR (mutation AND NOT ertad.event_manager(actor,e)) THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
  END IF;
  IF mutation THEN
   fp:=encode(sha256(convert_to((input-'key')::text,'UTF8')),'hex');
   SELECT * INTO receipt FROM ertad.event_commands WHERE organization_id=org AND actor_id=actor AND key=(input->>'key')::uuid;
   IF FOUND THEN
    IF receipt.operation<>op OR receipt.fingerprint<>fp THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Retry conflict'; END IF;
    RETURN jsonb_build_object('data',receipt.response,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'eventId',receipt.event_id,'changed',false));
   END IF;
  END IF;
  IF op='event_detail' THEN
   SELECT COALESCE(jsonb_agg(ertad.work_view(actor,w) ORDER BY w.created_at,w.id),'[]') INTO tasks
    FROM ertad.work_items w WHERE w.organization_id=org AND w.event_id=e.id AND ertad.work_visible(actor,w);
   data:=ertad.event_view(actor,e)||jsonb_build_object('tasks',tasks);
  ELSIF op='event_create' THEN
   IF (input->>'endsAt')::timestamptz<=clock_timestamp() OR (input->>'endsAt')::timestamptz>clock_timestamp()+interval '1 year' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid event period'; END IF;
   IF input->>'contributionRuleId' IS NOT NULL THEN
    SELECT * INTO r FROM ertad.contribution_rules WHERE organization_id=org AND id=(input->>'contributionRuleId')::uuid;
    IF NOT FOUND OR r.category<>'task' OR NOT r.enabled OR NOT ertad.contribution_template_allowed(actor,r,(input->>'unitId')::uuid)
     OR EXISTS(SELECT 1 FROM ertad.contribution_rules newer WHERE newer.organization_id=org AND newer.category=r.category AND newer.template_id IS NOT DISTINCT FROM r.template_id AND newer.version>r.version) THEN
     RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Reward offer unavailable'; END IF;
   END IF;
   INSERT INTO ertad.mobilization_events(organization_id,unit_id,creator_id,title,description,location,starts_at,ends_at,scope_path,contribution_rule_id)
   VALUES(org,(input->>'unitId')::uuid,actor,trim(input->>'title'),COALESCE(input->>'description',''),trim(COALESCE(input->>'location','')),
    (input->>'startsAt')::timestamptz,(input->>'endsAt')::timestamptz,ertad.unit_path(org,(input->>'unitId')::uuid),(input->>'contributionRuleId')::uuid) RETURNING * INTO e;
   changed:=true; data:=jsonb_build_object('id',e.id,'version',e.version);
  ELSE
   IF e.version IS DISTINCT FROM (input->>'version')::integer OR e.status<>'open' OR EXISTS(
    SELECT 1 FROM ertad.work_items WHERE organization_id=org AND event_id=e.id AND status IN ('open','offered')) THEN
    RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Close linked tasks first'; END IF;
   UPDATE ertad.mobilization_events SET status=CASE WHEN op='event_complete' THEN 'completed' ELSE 'cancelled' END,version=version+1
    WHERE organization_id=org AND id=e.id RETURNING * INTO e;
   changed:=true; data:=jsonb_build_object('id',e.id,'version',e.version);
  END IF;
  IF changed THEN INSERT INTO ertad.event_commands VALUES(org,actor,(input->>'key')::uuid,e.id,op,fp,data); END IF;
 END IF;
 RETURN jsonb_build_object('data',data,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'eventId',e.id,'changed',changed));
END $$;

ALTER FUNCTION ertad.work_finish(uuid,text,text,uuid,jsonb,boolean) RENAME TO work_before_events_finish;
CREATE FUNCTION ertad.work_finish(sid uuid,token text,op text,org uuid,input jsonb,changed boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid; e ertad.mobilization_events; event uuid;
BEGIN
 IF op IN ('event_create','event_complete','event_cancel') THEN
  actor:=ertad.review_identity(sid,token,true);
  SELECT event_id INTO event FROM ertad.event_commands WHERE organization_id=org AND actor_id=actor AND key=(input->>'key')::uuid;
  SELECT * INTO e FROM ertad.mobilization_events WHERE organization_id=org AND id=event;
  IF NOT FOUND OR NOT ertad.event_manager(actor,e) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
  IF changed AND op='event_create' AND e.ends_at<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Event ended'; END IF;
 ELSE
  PERFORM ertad.work_before_events_finish(sid,token,op,org,input,changed);
  IF op IN ('create','delegate') THEN
   actor:=ertad.review_identity(sid,token,true);
   SELECT w.event_id INTO event FROM ertad.work_commands c JOIN ertad.work_items w ON w.organization_id=c.organization_id AND w.id=c.work_id
    WHERE c.organization_id=org AND c.actor_id=actor AND c.key=(input->>'key')::uuid;
   IF event IS NOT NULL THEN
    SELECT * INTO e FROM ertad.mobilization_events WHERE organization_id=org AND id=event;
    IF NOT ertad.event_visible(actor,e) OR (op='create' AND NOT ertad.event_manager(actor,e)) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
    IF changed AND (e.status<>'open' OR e.ends_at<=clock_timestamp()) THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Event closed'; END IF;
   END IF;
  END IF;
 END IF;
END $$;
REVOKE ALL ON ertad.mobilization_events,ertad.event_commands,ertad.event_participation_claims FROM PUBLIC,ertad_app;
REVOKE ALL ON FUNCTION ertad.event_manager(uuid,ertad.mobilization_events),ertad.event_visible(uuid,ertad.mobilization_events),ertad.event_view(uuid,ertad.mobilization_events),
 ertad.work_before_events_command(uuid,text,text,uuid,jsonb),ertad.work_before_events_finish(uuid,text,text,uuid,jsonb,boolean) FROM PUBLIC,ertad_app;
REVOKE ALL ON FUNCTION ertad.work_command(uuid,text,text,uuid,jsonb),ertad.work_finish(uuid,text,text,uuid,jsonb,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.work_command(uuid,text,text,uuid,jsonb),ertad.work_finish(uuid,text,text,uuid,jsonb,boolean) TO ertad_app;
