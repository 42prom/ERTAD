-- Territorial Groups Stage T2: Atomic Main Group Channel Provisioning
-- When an independent reviewer approves creation of a 'group' operational unit,
-- create exactly one main group channel (is_main = true) inside the same transaction.

ALTER TABLE ertad.channels
  ADD COLUMN is_main boolean NOT NULL DEFAULT false;

ALTER TABLE ertad.channels
  ADD CONSTRAINT channels_main_group_chk CHECK (
    (NOT is_main) OR (channel_kind = 'group' AND work_id IS NULL)
  );

CREATE UNIQUE INDEX channels_unit_main_unique
  ON ertad.channels (organization_id, unit_id)
  WHERE is_main = true AND channel_kind = 'group';

ALTER TABLE ertad.unit_reviews
  ADD COLUMN main_channel_id uuid;

ALTER TABLE ertad.unit_reviews
  ADD CONSTRAINT unit_reviews_main_channel_fk
  FOREIGN KEY (organization_id, main_channel_id)
  REFERENCES ertad.channels (organization_id, id);

CREATE OR REPLACE FUNCTION ertad.freeze_unit_review() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Immutable review'; END IF;
  IF OLD.status<>'pending' OR NEW.status NOT IN ('approved','rejected') OR
    (to_jsonb(NEW)-ARRAY['status','decision_by','decision_key','decision_reason','decision_at','unit_id','main_channel_id']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['status','decision_by','decision_key','decision_reason','decision_at','unit_id','main_channel_id']) OR
    (NEW.main_channel_id IS NOT NULL AND NOT (NEW.status='approved' AND OLD.main_channel_id IS NULL AND NEW.kind='create' AND NEW.operational_type='group')) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Immutable review'; END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION ertad.unit_command(sid uuid,token text,op text,org uuid,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_column
DECLARE actor uuid; r ertad.unit_reviews; result jsonb; changed boolean:=false;
  target ertad.units; change_kind text; propose_permission text; approve_permission text;
  parent uuid; expiry timestamptz; page integer; view_name text; new_unit uuid; new_channel uuid;
  main_title text; area text; unit_type text;
BEGIN
  IF op NOT IN ('contexts','units','list','detail','propose','change','decide','geography') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid operation'; END IF;
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
  ELSIF op='geography' THEN
    IF NOT EXISTS(SELECT 1 FROM ertad.units u WHERE u.organization_id=org AND ertad.review_has_scope(actor,org,u.id,'unit.read')) THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
    SELECT jsonb_build_object('version','2026-11-26.1','coverage','operational_baseline',
      'additionalReferencesPending',true,'items',COALESCE(jsonb_agg(jsonb_build_object(
        'id',a.id,'parentId',a.parent_id,'kind',a.kind,'nameKa',a.name_ka,'nameEn',a.name_en) ORDER BY a.name_ka,a.id),'[]'))
    INTO result FROM (SELECT * FROM ertad.geographic_areas WHERE active ORDER BY id LIMIT 500) a;
  ELSIF op='units' THEN
    IF COALESCE(input->>'status','active') NOT IN ('active','archived') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid status'; END IF;
    page:=COALESCE((input->>'page')::integer,1);
    IF page NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid page'; END IF;
    WITH visible AS (SELECT u.id,u.name,u.kind,u.status,u.version,u.operational_type,u.geographic_area_id,
      CASE WHEN u.parent_id IS NULL THEN jsonb_build_array('unclassified','region')
        WHEN u.operational_type='region' THEN jsonb_build_array('locality')
        WHEN u.operational_type='locality' THEN jsonb_build_array('group')
        WHEN u.operational_type='group' THEN jsonb_build_array('team')
        WHEN u.operational_type='team' THEN '[]'::jsonb ELSE jsonb_build_array('unclassified') END AS child_types,
      CASE WHEN u.operational_type<>'unclassified' OR u.parent_id IS NULL
        OR NOT ertad.review_has_scope(actor,org,u.parent_id,'unit.read') THEN '[]'::jsonb
        WHEN EXISTS(SELECT 1 FROM ertad.units p WHERE p.organization_id=org AND p.id=u.parent_id AND p.parent_id IS NULL) THEN jsonb_build_array('region')
        ELSE COALESCE((SELECT CASE p.operational_type WHEN 'region' THEN jsonb_build_array('locality')
          WHEN 'locality' THEN jsonb_build_array('group') WHEN 'group' THEN jsonb_build_array('team') ELSE '[]'::jsonb END
          FROM ertad.units p WHERE p.organization_id=org AND p.id=u.parent_id),'[]'::jsonb) END AS classify_types,
      CASE WHEN ertad.review_has_scope(actor,org,u.parent_id,'unit.read') THEN
        (SELECT p.geographic_area_id FROM ertad.units p WHERE p.organization_id=org AND p.id=u.parent_id) ELSE NULL END AS parent_geographic_area_id,
      (SELECT jsonb_build_object('id',g.id,'nameKa',g.name_ka,'nameEn',g.name_en) FROM ertad.geographic_areas g WHERE g.id=u.geographic_area_id) AS geography,
      CASE WHEN ertad.review_has_scope(actor,org,u.id,'channel.read') THEN
        (SELECT c.id FROM ertad.channels c WHERE c.organization_id=org AND c.unit_id=u.id AND c.is_main AND NOT c.archived LIMIT 1) ELSE NULL END AS main_channel_id,
      u.status='active' AND u.kind='authority' AND u.parent_id IS NOT NULL AND u.operational_type='unclassified'
       AND ertad.review_has_scope(actor,org,u.parent_id,'unit.read')
       AND ertad.review_has_scope(actor,org,u.parent_id,'unit.change.propose') AS "canClassify",
      CASE WHEN ertad.review_has_scope(actor,org,u.parent_id,'unit.read') THEN u.parent_id ELSE NULL END AS parent_id,
      CASE WHEN ertad.review_has_scope(actor,org,u.parent_id,'unit.read') THEN (SELECT p.name FROM ertad.units p WHERE p.organization_id=org AND p.id=u.parent_id) ELSE NULL END AS parent_name,
      u.status='active' AND ertad.review_has_scope(actor,org,u.id,'unit.propose') AND u.kind='authority' AND u.operational_type<>'team' AS "canPropose",
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
    unit_type:=COALESCE(input->>'operationalType','unclassified'); area:=input->>'geographicAreaId';
    IF NOT ertad.review_has_scope(actor,org,parent,'unit.read') OR NOT ertad.review_has_scope(actor,org,parent,'unit.propose') THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
    SELECT * INTO r FROM ertad.unit_reviews WHERE organization_id=org AND requester_id=actor AND request_key=(input->>'key')::uuid;
    IF FOUND THEN
      IF r.kind<>'create' OR (r.parent_id,r.name,r.reason,r.expires_at,r.operational_type,r.geographic_area_id) IS DISTINCT FROM (parent,trim(input->>'name'),trim(input->>'reason'),expiry,unit_type,area) THEN
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request conflict'; END IF;
    ELSE
      IF NOT EXISTS(SELECT 1 FROM ertad.units WHERE organization_id=org AND id=parent AND kind='authority' AND status='active')
        OR expiry<=clock_timestamp() OR expiry>clock_timestamp()+interval '7 days' THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid parent or deadline'; END IF;
      PERFORM ertad.validate_unit_territory(org,parent,unit_type,area);
      INSERT INTO ertad.unit_reviews(organization_id,parent_id,parent_path,name,requester_id,reason,request_key,expires_at,operational_type,geographic_area_id,parent_territory_version)
        VALUES(org,parent,ertad.unit_path(org,parent),trim(input->>'name'),actor,trim(input->>'reason'),(input->>'key')::uuid,expiry,unit_type,area,(SELECT territory_version FROM ertad.units WHERE organization_id=org AND id=parent)) RETURNING * INTO r;
      changed:=true;
    END IF;
    result:=jsonb_build_object('id',r.id,'status',r.status,'unitId',r.unit_id);
  ELSIF op='change' THEN
    change_kind:=input->>'kind'; expiry:=(input->>'expiresAt')::timestamptz;
    IF change_kind IS NULL OR change_kind NOT IN ('rename','archive','restore','territory')
      OR (change_kind='rename' AND (input->>'name' IS NULL OR length(trim(input->>'name')) NOT BETWEEN 1 AND 160))
      OR (change_kind IN ('archive','restore','territory') AND input ? 'name') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid change'; END IF;
    SELECT * INTO target FROM ertad.units WHERE organization_id=org AND id=(input->>'unitId')::uuid;
    IF NOT FOUND OR target.parent_id IS NULL OR target.kind<>'authority'
      OR NOT ertad.review_has_scope(actor,org,target.parent_id,'unit.read')
      OR NOT ertad.review_has_scope(actor,org,target.parent_id,'unit.change.propose') THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
    unit_type:=CASE WHEN change_kind='territory' THEN input->>'operationalType' ELSE target.operational_type END;
    area:=CASE WHEN change_kind='territory' THEN input->>'geographicAreaId' ELSE target.geographic_area_id END;
    SELECT * INTO r FROM ertad.unit_reviews WHERE organization_id=org AND requester_id=actor AND request_key=(input->>'key')::uuid;
    IF FOUND THEN
      IF (r.kind,r.target_id,r.target_version,r.reason,r.expires_at) IS DISTINCT FROM
        (change_kind,target.id,(input->>'version')::integer,trim(input->>'reason'),expiry)
        OR (change_kind='rename' AND r.name IS DISTINCT FROM trim(input->>'name'))
        OR (change_kind='territory' AND (r.operational_type,r.geographic_area_id) IS DISTINCT FROM (unit_type,area)) THEN
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Request conflict'; END IF;
    ELSE
      IF target.status IS DISTINCT FROM (CASE WHEN change_kind='restore' THEN 'archived' ELSE 'active' END) OR target.version IS DISTINCT FROM (input->>'version')::integer
        OR (change_kind='rename' AND target.name=trim(input->>'name')) THEN
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Unit changed'; END IF;
      IF expiry<=clock_timestamp() OR expiry>clock_timestamp()+interval '7 days' THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid deadline'; END IF;
      IF change_kind='territory' THEN
        IF target.operational_type<>'unclassified' OR unit_type IS NULL OR unit_type='unclassified' THEN
          RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Territory already classified'; END IF;
        PERFORM ertad.validate_unit_territory(org,target.parent_id,unit_type,area);
      END IF;
      IF change_kind='archive' AND cardinality(ertad.unit_archive_blockers(org,target.id))>0 THEN
        RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Unit has linked records'; END IF;
      INSERT INTO ertad.unit_reviews(organization_id,parent_id,parent_path,name,requester_id,reason,request_key,expires_at,kind,target_id,target_version,original_name,operational_type,geographic_area_id,parent_territory_version)
      VALUES(org,target.parent_id,ertad.unit_path(org,target.parent_id),
        CASE WHEN change_kind='rename' THEN trim(input->>'name') ELSE target.name END,
        actor,trim(input->>'reason'),(input->>'key')::uuid,expiry,change_kind,target.id,target.version,target.name,unit_type,area,(SELECT territory_version FROM ertad.units WHERE organization_id=org AND id=target.parent_id)) RETURNING * INTO r;
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
          IF r.kind IN ('create','territory') THEN
            IF r.parent_territory_version IS NOT NULL AND r.parent_territory_version IS DISTINCT FROM
              (SELECT territory_version FROM ertad.units WHERE organization_id=org AND id=r.parent_id) THEN
              RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Territorial parent changed'; END IF;
            PERFORM ertad.validate_unit_territory(org,r.parent_id,r.operational_type,r.geographic_area_id);
          END IF;
          IF r.kind IN ('create','rename','restore') AND EXISTS(SELECT 1 FROM ertad.units WHERE organization_id=org AND parent_id=r.parent_id AND id IS DISTINCT FROM r.target_id AND status='active' AND lower(trim(name))=lower(r.name)) THEN
            RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Duplicate unit'; END IF;
          IF r.kind='create' THEN
            INSERT INTO ertad.units(organization_id,parent_id,name,kind,operational_type,geographic_area_id) VALUES(org,r.parent_id,r.name,'authority',r.operational_type,r.geographic_area_id) RETURNING id INTO new_unit;
            IF r.operational_type='group' THEN
              main_title:=CASE WHEN length(trim(r.name))>=3 THEN left(trim(r.name),120) ELSE left(trim(r.name)||' chat',120) END;
              INSERT INTO ertad.channels(organization_id,unit_id,scope_path,title,creator_id,channel_kind,is_main)
                VALUES(org,new_unit,ertad.unit_path(org,new_unit),main_title,actor,'group',true)
                RETURNING id INTO new_channel;
            END IF;
          ELSE
            IF r.kind='archive' AND cardinality(ertad.unit_archive_blockers(org,r.target_id,r.id))>0 THEN
              RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Unit has linked records'; END IF;
            UPDATE ertad.units SET name=r.name,status=CASE WHEN r.kind='archive' THEN 'archived' ELSE 'active' END,
              operational_type=CASE WHEN r.kind='territory' THEN r.operational_type ELSE operational_type END,
              geographic_area_id=CASE WHEN r.kind='territory' THEN r.geographic_area_id ELSE geographic_area_id END
              WHERE organization_id=org AND id=r.target_id RETURNING id INTO new_unit;
          END IF;
        END IF;
        UPDATE ertad.unit_reviews SET status=input->>'decision',decision_by=actor,decision_key=(input->>'key')::uuid,
          decision_reason=trim(input->>'reason'),decision_at=clock_timestamp(),unit_id=new_unit,main_channel_id=new_channel
          WHERE organization_id=org AND id=r.id RETURNING * INTO r;
        changed:=true;
      END IF;
      result:=jsonb_build_object('id',r.id,'status',r.status,'unitId',r.unit_id,'mainChannelId',r.main_channel_id);
    ELSE
      result:=(to_jsonb(r)-ARRAY['request_key','decision_key','parent_path'])||jsonb_build_object('parent_name',
        (SELECT name FROM ertad.units WHERE organization_id=org AND id=r.parent_id),
        'status',CASE WHEN r.status='pending' AND r.expires_at<=clock_timestamp() THEN 'expired' ELSE r.status END,
        'operational_type',r.operational_type,'geographic_area_id',r.geographic_area_id,
        'main_channel_id',CASE WHEN r.unit_id IS NOT NULL AND ertad.review_has_scope(actor,org,r.unit_id,'channel.read') THEN r.main_channel_id ELSE NULL END,
        'geography',(SELECT jsonb_build_object('id',g.id,'nameKa',g.name_ka,'nameEn',g.name_en) FROM ertad.geographic_areas g WHERE g.id=r.geographic_area_id),
        'canDecide',r.status='pending' AND r.expires_at>clock_timestamp() AND actor<>r.requester_id AND ertad.review_has_scope(actor,org,r.parent_id,approve_permission));
    END IF;
  ELSE
    page:=COALESCE((input->>'page')::integer,1);view_name:=COALESCE(input->>'view','pending');
    IF page NOT BETWEEN 1 AND 1000 OR view_name NOT IN ('pending','mine','history') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid filter'; END IF;
    WITH visible AS (SELECT r.id,r.name,r.kind,r.original_name,r.target_id,r.operational_type,r.geographic_area_id,u.name AS parent_name,r.parent_id,r.created_at,r.expires_at,
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
