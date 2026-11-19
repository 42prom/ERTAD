-- First Decisions journey: explicitly named, single-choice advisory polls.
-- Anonymous decisions must use a separate storage contract, never this vote/receipt table.
ALTER TABLE ertad.permission_grants DROP CONSTRAINT permission_grants_permission_check;
ALTER TABLE ertad.permission_grants ADD CONSTRAINT permission_grants_permission_check CHECK
 (permission IN ('unit.read','workitem.create','workitem.verify','membership.propose','membership.approve','unit.propose','unit.approve',
 'decision.read','decision.manage','decision.publish','decision.vote'));

CREATE TABLE ertad.decisions (
 organization_id uuid NOT NULL REFERENCES ertad.organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 unit_id uuid NOT NULL, creator_id uuid NOT NULL REFERENCES ertad.member_users(id),
 title text NOT NULL CHECK(length(trim(title)) BETWEEN 3 AND 160), description text NOT NULL CHECK(length(description)<=3000),
 options text[] NOT NULL CHECK(cardinality(options) BETWEEN 2 AND 8),
 privacy text NOT NULL DEFAULT 'named' CHECK(privacy='named'),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','open','closed','cancelled')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), quorum integer NOT NULL CHECK(quorum BETWEEN 1 AND 100),
 closes_at timestamptz NOT NULL CHECK(isfinite(closes_at)), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 opened_at timestamptz, closed_at timestamptz, scope_path uuid[],
 PRIMARY KEY(organization_id,id), FOREIGN KEY(organization_id,unit_id) REFERENCES ertad.units(organization_id,id)
);
CREATE INDEX decisions_scope ON ertad.decisions(organization_id,unit_id,status,created_at,id);
CREATE TABLE ertad.decision_electorate (
 organization_id uuid NOT NULL, decision_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES ertad.member_users(id),
 membership_id uuid NOT NULL, PRIMARY KEY(organization_id,decision_id,user_id),
 FOREIGN KEY(organization_id,decision_id) REFERENCES ertad.decisions(organization_id,id),
 FOREIGN KEY(organization_id,membership_id) REFERENCES ertad.memberships(organization_id,id)
);
CREATE TABLE ertad.decision_named_votes (
 organization_id uuid NOT NULL, decision_id uuid NOT NULL, user_id uuid NOT NULL, choice integer NOT NULL CHECK(choice BETWEEN 0 AND 7),
 PRIMARY KEY(organization_id,decision_id,user_id),
 FOREIGN KEY(organization_id,decision_id,user_id) REFERENCES ertad.decision_electorate(organization_id,decision_id,user_id)
);
CREATE TABLE ertad.decision_commands (
 organization_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES ertad.member_users(id), key uuid NOT NULL,
 decision_id uuid NOT NULL, operation text NOT NULL, payload jsonb NOT NULL, response jsonb NOT NULL,
 PRIMARY KEY(organization_id,actor_id,key),
 FOREIGN KEY(organization_id,decision_id) REFERENCES ertad.decisions(organization_id,id)
);
CREATE TRIGGER immutable_named_votes BEFORE UPDATE OR DELETE ON ertad.decision_named_votes FOR EACH ROW EXECUTE FUNCTION ertad.prevent_audit_log_mutation();
CREATE TRIGGER immutable_electorate BEFORE UPDATE OR DELETE ON ertad.decision_electorate FOR EACH ROW EXECUTE FUNCTION ertad.prevent_audit_log_mutation();
CREATE TRIGGER immutable_decision_commands BEFORE UPDATE OR DELETE ON ertad.decision_commands FOR EACH ROW EXECUTE FUNCTION ertad.prevent_audit_log_mutation();
CREATE TRIGGER no_truncate_named_votes BEFORE TRUNCATE ON ertad.decision_named_votes FOR EACH STATEMENT EXECUTE FUNCTION ertad.prevent_audit_log_mutation();
CREATE TRIGGER no_truncate_electorate BEFORE TRUNCATE ON ertad.decision_electorate FOR EACH STATEMENT EXECUTE FUNCTION ertad.prevent_audit_log_mutation();
CREATE TRIGGER no_truncate_decision_commands BEFORE TRUNCATE ON ertad.decision_commands FOR EACH STATEMENT EXECUTE FUNCTION ertad.prevent_audit_log_mutation();

CREATE FUNCTION ertad.decision_eligible(actor uuid,org uuid,scope_unit uuid,mid uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM ertad.memberships m
 JOIN ertad.positions p ON (p.organization_id,p.id,p.unit_id)=(m.organization_id,m.position_id,m.unit_id)
 JOIN ertad.permission_bundles b ON (b.organization_id,b.id,b.version)=(p.organization_id,p.bundle_id,p.bundle_version)
 JOIN ertad.permission_grants g ON (g.organization_id,g.bundle_id,g.bundle_version)=(b.organization_id,b.id,b.version)
 WHERE m.organization_id=org AND m.id=mid AND m.user_id=actor AND m.status='active'
 AND m.valid_from<=clock_timestamp() AND m.valid_until>clock_timestamp() AND p.status='active'
 AND b.status='approved' AND m.bundle_version=p.bundle_version AND g.permission='decision.vote'
 AND scope_unit=ANY(ertad.unit_path(org,m.unit_id)) AND ertad.review_has_scope(actor,org,m.unit_id,'decision.vote'));
$$;
CREATE FUNCTION ertad.decision_visible(actor uuid,d ertad.decisions) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT ertad.review_has_scope(actor,d.organization_id,d.unit_id,'decision.read') OR
 (d.status<>'draft' AND EXISTS(SELECT 1 FROM ertad.decision_electorate e WHERE e.organization_id=d.organization_id AND e.decision_id=d.id AND e.user_id=actor
 AND ertad.decision_eligible(actor,d.organization_id,d.unit_id,e.membership_id)));
$$;
CREATE FUNCTION ertad.decision_view(actor uuid,d ertad.decisions) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE finished boolean; eligible boolean; voted boolean; total integer; counts jsonb; result jsonb;
BEGIN
 finished:=d.status='closed' OR (d.status='open' AND d.closes_at<=clock_timestamp());
 eligible:=EXISTS(SELECT 1 FROM ertad.decision_electorate e WHERE e.organization_id=d.organization_id AND e.decision_id=d.id AND e.user_id=actor
   AND ertad.decision_eligible(actor,d.organization_id,d.unit_id,e.membership_id));
 voted:=EXISTS(SELECT 1 FROM ertad.decision_named_votes v WHERE v.organization_id=d.organization_id AND v.decision_id=d.id AND v.user_id=actor);
 SELECT count(*) INTO total FROM ertad.decision_electorate WHERE organization_id=d.organization_id AND decision_id=d.id;
 result:=jsonb_build_object('id',d.id,'unitId',d.unit_id,'unitName',(SELECT name FROM ertad.units WHERE organization_id=d.organization_id AND id=d.unit_id),
 'title',d.title,'description',d.description,'options',d.options,'privacy',d.privacy,'version',d.version,'quorum',d.quorum,
 'status',CASE WHEN finished THEN 'closed' ELSE d.status END,'closesAt',d.closes_at,'electorate',total,'voted',voted,
 'canManage',ertad.review_has_scope(actor,d.organization_id,d.unit_id,'decision.manage'),
 'canPublish',ertad.review_has_scope(actor,d.organization_id,d.unit_id,'decision.publish'),
 'canVote',eligible AND NOT voted AND d.status='open' AND NOT finished AND d.scope_path=ertad.unit_path(d.organization_id,d.unit_id));
 IF finished THEN
   SELECT jsonb_agg(jsonb_build_object('label',o.label,'votes',(SELECT count(*) FROM ertad.decision_named_votes v
    WHERE v.organization_id=d.organization_id AND v.decision_id=d.id AND v.choice=o.n-1)) ORDER BY o.n)
   INTO counts FROM unnest(d.options) WITH ORDINALITY o(label,n);
   result:=result||jsonb_build_object('results',counts,'participation',(SELECT count(*) FROM ertad.decision_named_votes WHERE organization_id=d.organization_id AND decision_id=d.id));
 END IF;
 RETURN result;
END; $$;

CREATE FUNCTION ertad.decision_command(sid uuid,token text,op text,org uuid,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_column
DECLARE actor uuid; d ertad.decisions; receipt ertad.decision_commands; result jsonb; changed boolean:=false;
 mutation boolean; permission text; opts text[]; target uuid; n integer; view_name text; payload jsonb; chosen integer;
BEGIN
 IF op NOT IN ('contexts','audiences','list','detail','create','update','publish','close','cancel','vote') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid operation'; END IF;
 mutation:=op IN ('create','update','publish','close','cancel','vote');
 actor:=ertad.review_identity(sid,token,mutation);
 IF op='contexts' THEN
  PERFORM 1 FROM ertad.organizations o WHERE EXISTS(SELECT 1 FROM ertad.memberships m WHERE m.organization_id=o.id AND m.user_id=actor) ORDER BY o.id FOR SHARE;
 ELSIF mutation THEN
  PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 ELSE
  PERFORM 1 FROM ertad.organizations WHERE id=org AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 END IF;
 PERFORM pg_advisory_xact_lock(752991884322001::bigint);
 PERFORM ertad.review_identity(sid,token,mutation);
 IF op='contexts' THEN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',o.id,'name',o.name) ORDER BY o.name,o.id),'[]') INTO result
  FROM ertad.organizations o WHERE o.status='active' AND EXISTS(SELECT 1 FROM ertad.units u WHERE u.organization_id=o.id
  AND (ertad.review_has_scope(actor,o.id,u.id,'decision.read') OR ertad.review_has_scope(actor,o.id,u.id,'decision.vote')));
 ELSIF op='audiences' THEN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',u.id,'name',u.name) ORDER BY u.name,u.id),'[]') INTO result
  FROM (SELECT * FROM ertad.units u WHERE u.organization_id=org AND u.kind='authority'
   AND ertad.review_has_scope(actor,org,u.id,'decision.manage') AND ertad.review_has_scope(actor,org,u.id,'decision.read') ORDER BY name,id LIMIT 250) u;
 ELSIF op='list' THEN
  n:=COALESCE((input->>'page')::integer,1); view_name:=COALESCE(input->>'view','open');
  IF n NOT BETWEEN 1 AND 1000 OR view_name NOT IN ('draft','open','closed','cancelled') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid filter'; END IF;
  WITH visible AS (SELECT d.* FROM ertad.decisions d WHERE d.organization_id=org AND ertad.decision_visible(actor,d)
   AND CASE WHEN d.status='open' AND d.closes_at<=clock_timestamp() THEN 'closed' ELSE d.status END=view_name
   AND position(lower(COALESCE(input->>'search','')) in lower(d.title))>0),
  paged AS (SELECT * FROM visible ORDER BY created_at DESC,id LIMIT 25 OFFSET (n-1)*25)
  SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(ertad.decision_view(actor,paged::ertad.decisions) ORDER BY created_at DESC,id) FROM paged),'[]'),
   'total',(SELECT count(*) FROM visible),'page',n,'pageSize',25) INTO result;
 ELSE
  IF op='create' THEN
   target:=(input->>'unitId')::uuid;
  ELSE
   SELECT * INTO d FROM ertad.decisions WHERE organization_id=org AND id=(input->>'id')::uuid;
   IF NOT FOUND OR NOT ertad.decision_visible(actor,d) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
   target:=d.unit_id;
  END IF;
  permission:=CASE WHEN op IN ('create','update','cancel') THEN 'decision.manage' WHEN op IN ('publish','close') THEN 'decision.publish' END;
  IF permission IS NOT NULL AND (NOT ertad.review_has_scope(actor,org,target,permission) OR NOT ertad.review_has_scope(actor,org,target,'decision.read')) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
  IF op='vote' AND NOT EXISTS(SELECT 1 FROM ertad.decision_electorate e WHERE e.organization_id=org AND e.decision_id=d.id AND e.user_id=actor
   AND ertad.decision_eligible(actor,org,d.unit_id,e.membership_id)) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Not eligible'; END IF;
  IF mutation THEN
   payload:=input-'key';
   SELECT * INTO receipt FROM ertad.decision_commands WHERE organization_id=org AND actor_id=actor AND key=(input->>'key')::uuid;
   IF FOUND THEN
    IF receipt.operation<>op OR receipt.payload<>payload THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Retry conflict'; END IF;
    RETURN jsonb_build_object('data',receipt.response,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'decisionId',receipt.decision_id,'changed',false));
   END IF;
  END IF;
  IF op='detail' THEN
   result:=ertad.decision_view(actor,d);
  ELSIF op IN ('create','update') THEN
   SELECT array_agg(trim(value) ORDER BY ordinality) INTO opts FROM jsonb_array_elements_text(input->'options') WITH ORDINALITY;
   IF COALESCE(cardinality(opts),0) NOT BETWEEN 2 AND 8 OR EXISTS(SELECT 1 FROM unnest(opts) o WHERE length(o) NOT BETWEEN 1 AND 160)
    OR (SELECT count(DISTINCT lower(o)) FROM unnest(opts) o)<>cardinality(opts)
    OR (input->>'closesAt')::timestamptz<=clock_timestamp() OR (input->>'closesAt')::timestamptz>clock_timestamp()+interval '90 days' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid poll definition'; END IF;
   IF NOT EXISTS(SELECT 1 FROM ertad.units WHERE organization_id=org AND id=target AND kind='authority' AND status='active') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Invalid audience'; END IF;
   IF op='create' THEN
    INSERT INTO ertad.decisions(organization_id,unit_id,creator_id,title,description,options,quorum,closes_at)
     VALUES(org,target,actor,trim(input->>'title'),input->>'description',opts,(input->>'quorum')::integer,(input->>'closesAt')::timestamptz) RETURNING * INTO d;
   ELSE
    IF d.status<>'draft' OR d.version IS DISTINCT FROM (input->>'version')::integer OR d.unit_id IS DISTINCT FROM (input->>'unitId')::uuid THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Draft conflict'; END IF;
    UPDATE ertad.decisions SET title=trim(input->>'title'),description=input->>'description',options=opts,quorum=(input->>'quorum')::integer,
     closes_at=(input->>'closesAt')::timestamptz,version=version+1 WHERE organization_id=org AND id=d.id RETURNING * INTO d;
   END IF;
   changed:=true; result:=jsonb_build_object('id',d.id,'status',d.status);
  ELSIF op='publish' THEN
   IF d.status<>'draft' OR d.version IS DISTINCT FROM (input->>'version')::integer OR d.closes_at<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Publication conflict'; END IF;
   INSERT INTO ertad.decision_electorate(organization_id,decision_id,user_id,membership_id)
    SELECT DISTINCT ON (m.user_id) org,d.id,m.user_id,m.id FROM ertad.memberships m WHERE m.organization_id=org
     AND ertad.decision_eligible(m.user_id,org,d.unit_id,m.id) ORDER BY m.user_id,m.id;
   IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Empty electorate'; END IF;
   UPDATE ertad.decisions SET status='open',opened_at=clock_timestamp(),scope_path=ertad.unit_path(org,unit_id),version=version+1
    WHERE organization_id=org AND id=d.id RETURNING * INTO d;
   changed:=true; result:=jsonb_build_object('id',d.id,'status','open');
  ELSIF op IN ('close','cancel') THEN
   IF d.version IS DISTINCT FROM (input->>'version')::integer OR d.status NOT IN ('draft','open') OR (op='close' AND d.status<>'open')
    OR (op='cancel' AND d.status='open' AND d.closes_at<=clock_timestamp()) THEN
    RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='State conflict'; END IF;
   UPDATE ertad.decisions SET status=CASE WHEN op='close' THEN 'closed' ELSE 'cancelled' END,closed_at=clock_timestamp(),version=version+1
    WHERE organization_id=org AND id=d.id RETURNING * INTO d;
   changed:=true; result:=jsonb_build_object('id',d.id,'status',d.status);
  ELSIF op='vote' THEN
   chosen:=(input->>'choice')::integer;
   IF d.status<>'open' OR d.closes_at<=clock_timestamp() OR d.scope_path IS DISTINCT FROM ertad.unit_path(org,d.unit_id) THEN
    RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Poll closed or scope changed'; END IF;
   IF chosen<0 OR chosen>=cardinality(d.options) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid choice'; END IF;
   IF EXISTS(SELECT 1 FROM ertad.decision_named_votes WHERE organization_id=org AND decision_id=d.id AND user_id=actor) THEN
    RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Already participated'; END IF;
   INSERT INTO ertad.decision_named_votes VALUES(org,d.id,actor,chosen);
   changed:=true; result:=jsonb_build_object('id',d.id,'status','recorded');
  END IF;
  IF mutation THEN INSERT INTO ertad.decision_commands VALUES(org,actor,(input->>'key')::uuid,d.id,op,payload,result); END IF;
 END IF;
 RETURN jsonb_build_object('data',result,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'decisionId',d.id,'changed',changed));
END; $$;

CREATE FUNCTION ertad.decision_finish(sid uuid,token text,org uuid,did uuid,op text,changed boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid; d ertad.decisions; permission text;
BEGIN
 actor:=ertad.review_identity(sid,token,true);
 SELECT * INTO d FROM ertad.decisions WHERE organization_id=org AND id=did;
 IF NOT FOUND OR NOT ertad.decision_visible(actor,d) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 permission:=CASE WHEN op IN ('create','update','cancel') THEN 'decision.manage' WHEN op IN ('publish','close') THEN 'decision.publish' END;
 IF permission IS NOT NULL AND (NOT ertad.review_has_scope(actor,org,d.unit_id,permission) OR NOT ertad.review_has_scope(actor,org,d.unit_id,'decision.read')) THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 IF op='vote' AND NOT EXISTS(SELECT 1 FROM ertad.decision_electorate e WHERE e.organization_id=org AND e.decision_id=did AND e.user_id=actor
   AND ertad.decision_eligible(actor,org,d.unit_id,e.membership_id)) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Not eligible'; END IF;
 IF changed AND op IN ('publish','vote') AND (d.closes_at<=clock_timestamp() OR d.scope_path IS DISTINCT FROM ertad.unit_path(org,d.unit_id)) THEN
  RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Deadline or scope changed'; END IF;
 IF changed AND op='cancel' AND d.opened_at IS NOT NULL AND d.closes_at<=clock_timestamp() THEN
  RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Poll already closed'; END IF;
END; $$;
REVOKE ALL ON FUNCTION ertad.decision_eligible(uuid,uuid,uuid,uuid),ertad.decision_visible(uuid,ertad.decisions),ertad.decision_view(uuid,ertad.decisions),
 ertad.decision_command(uuid,text,text,uuid,jsonb),ertad.decision_finish(uuid,text,uuid,uuid,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.decision_command(uuid,text,text,uuid,jsonb),ertad.decision_finish(uuid,text,uuid,uuid,text,boolean) TO ertad_app;
