-- Shared non-personal reference data; no units, memberships or grants are seeded.
-- Local identifiers below the region level are ERTAD catalogue keys, not official ISO codes.
-- Initial coverage: 12 regions/capital entries, 63 municipalities outside Tbilisi,
-- and 10 Tbilisi districts. Additional de jure/occupied-territory references require
-- reconciliation; Abkhazia is retained and explicitly marked as incomplete in the API.
CREATE TABLE ertad.geographic_areas (
 id text PRIMARY KEY CHECK(id ~ '^GE-[A-Z0-9-]+$'),
 parent_id text REFERENCES ertad.geographic_areas(id),
 kind text NOT NULL CHECK(kind IN ('region','municipality','district')),
 name_ka text NOT NULL, name_en text NOT NULL,
 source_url text NOT NULL, source_checked_on date NOT NULL DEFAULT DATE '2026-11-26',
 catalogue_version text NOT NULL DEFAULT '2026-11-26.1',
 active boolean NOT NULL DEFAULT true,
 CHECK((kind='region')=(parent_id IS NULL)), CHECK(id IS DISTINCT FROM parent_id)
);
CREATE INDEX geographic_areas_parent ON ertad.geographic_areas(parent_id,kind,id);
INSERT INTO ertad.geographic_areas(id,parent_id,kind,name_ka,name_en,source_url) VALUES
 ('GE-TB',NULL,'region','თბილისი','Tbilisi','https://www.geostat.ge/ka/modules/categories/68/regionebis-mikhedvit'),
 ('GE-AJ',NULL,'region','აჭარა','Adjara','https://www.geostat.ge/ka/modules/categories/68/regionebis-mikhedvit'),
 ('GE-GU',NULL,'region','გურია','Guria','https://www.geostat.ge/ka/modules/categories/68/regionebis-mikhedvit'),
 ('GE-IM',NULL,'region','იმერეთი','Imereti','https://www.geostat.ge/ka/modules/categories/68/regionebis-mikhedvit'),
 ('GE-KA',NULL,'region','კახეთი','Kakheti','https://www.geostat.ge/ka/modules/categories/68/regionebis-mikhedvit'),
 ('GE-KK',NULL,'region','ქვემო ქართლი','Kvemo Kartli','https://www.geostat.ge/ka/modules/categories/68/regionebis-mikhedvit'),
 ('GE-MM',NULL,'region','მცხეთა-მთიანეთი','Mtskheta-Mtianeti','https://www.geostat.ge/ka/modules/categories/68/regionebis-mikhedvit'),
 ('GE-RL',NULL,'region','რაჭა-ლეჩხუმი და ქვემო სვანეთი','Racha-Lechkhumi and Kvemo Svaneti','https://www.geostat.ge/ka/modules/categories/68/regionebis-mikhedvit'),
 ('GE-SZ',NULL,'region','სამეგრელო-ზემო სვანეთი','Samegrelo-Zemo Svaneti','https://www.geostat.ge/ka/modules/categories/68/regionebis-mikhedvit'),
 ('GE-SJ',NULL,'region','სამცხე-ჯავახეთი','Samtskhe-Javakheti','https://www.geostat.ge/ka/modules/categories/68/regionebis-mikhedvit'),
 ('GE-SK',NULL,'region','შიდა ქართლი','Shida Kartli','https://www.geostat.ge/ka/modules/categories/68/regionebis-mikhedvit'),
 ('GE-AB',NULL,'region','აფხაზეთი','Abkhazia','https://www.geostat.ge/ka/modules/categories/68/regionebis-mikhedvit'),
 ('GE-AJ-BATUMI','GE-AJ','municipality','ბათუმი','Batumi','https://mreg.napr.gov.ge/v2/'),
 ('GE-AJ-KEDA','GE-AJ','municipality','ქედა','Keda','https://mreg.napr.gov.ge/v2/'),
 ('GE-AJ-KOBULETI','GE-AJ','municipality','ქობულეთი','Kobuleti','https://mreg.napr.gov.ge/v2/'),
 ('GE-AJ-SHUAKHEVI','GE-AJ','municipality','შუახევი','Shuakhevi','https://mreg.napr.gov.ge/v2/'),
 ('GE-AJ-KHELVACHAURI','GE-AJ','municipality','ხელვაჩაური','Khelvachauri','https://mreg.napr.gov.ge/v2/'),
 ('GE-AJ-KHULO','GE-AJ','municipality','ხულო','Khulo','https://mreg.napr.gov.ge/v2/'),
 ('GE-GU-LANCHKHUTI','GE-GU','municipality','ლანჩხუთი','Lanchkhuti','https://mreg.napr.gov.ge/v2/'),
 ('GE-GU-OZURGETI','GE-GU','municipality','ოზურგეთი','Ozurgeti','https://mreg.napr.gov.ge/v2/'),
 ('GE-GU-CHOKHATAURI','GE-GU','municipality','ჩოხატაური','Chokhatauri','https://mreg.napr.gov.ge/v2/'),
 ('GE-IM-KUTAISI','GE-IM','municipality','ქუთაისი','Kutaisi','https://mreg.napr.gov.ge/v2/'),
 ('GE-IM-BAGHDATI','GE-IM','municipality','ბაღდათი','Baghdati','https://mreg.napr.gov.ge/v2/'),
 ('GE-IM-VANI','GE-IM','municipality','ვანი','Vani','https://mreg.napr.gov.ge/v2/'),
 ('GE-IM-ZESTAPONI','GE-IM','municipality','ზესტაფონი','Zestaponi','https://mreg.napr.gov.ge/v2/'),
 ('GE-IM-TERJOLA','GE-IM','municipality','თერჯოლა','Terjola','https://mreg.napr.gov.ge/v2/'),
 ('GE-IM-SAMTREDIA','GE-IM','municipality','სამტრედია','Samtredia','https://mreg.napr.gov.ge/v2/'),
 ('GE-IM-SACHKHERE','GE-IM','municipality','საჩხერე','Sachkhere','https://mreg.napr.gov.ge/v2/'),
 ('GE-IM-TKIBULI','GE-IM','municipality','ტყიბული','Tkibuli','https://mreg.napr.gov.ge/v2/'),
 ('GE-IM-TSKALTUBO','GE-IM','municipality','წყალტუბო','Tskaltubo','https://mreg.napr.gov.ge/v2/'),
 ('GE-IM-CHIATURA','GE-IM','municipality','ჭიათურა','Chiatura','https://mreg.napr.gov.ge/v2/'),
 ('GE-IM-KHARAGAULI','GE-IM','municipality','ხარაგაული','Kharagauli','https://mreg.napr.gov.ge/v2/'),
 ('GE-IM-KHONI','GE-IM','municipality','ხონი','Khoni','https://mreg.napr.gov.ge/v2/'),
 ('GE-KA-AKHMETA','GE-KA','municipality','ახმეტა','Akhmeta','https://mreg.napr.gov.ge/v2/'),
 ('GE-KA-GURJAANI','GE-KA','municipality','გურჯაანი','Gurjaani','https://mreg.napr.gov.ge/v2/'),
 ('GE-KA-DEDOPLISTSKARO','GE-KA','municipality','დედოფლისწყარო','Dedoplistskaro','https://mreg.napr.gov.ge/v2/'),
 ('GE-KA-TELAVI','GE-KA','municipality','თელავი','Telavi','https://mreg.napr.gov.ge/v2/'),
 ('GE-KA-LAGODEKHI','GE-KA','municipality','ლაგოდეხი','Lagodekhi','https://mreg.napr.gov.ge/v2/'),
 ('GE-KA-SAGAREJO','GE-KA','municipality','საგარეჯო','Sagarejo','https://mreg.napr.gov.ge/v2/'),
 ('GE-KA-SIGHNAGHI','GE-KA','municipality','სიღნაღი','Sighnaghi','https://mreg.napr.gov.ge/v2/'),
 ('GE-KA-KVARELI','GE-KA','municipality','ყვარელი','Kvareli','https://mreg.napr.gov.ge/v2/'),
 ('GE-KK-RUSTAVI','GE-KK','municipality','რუსთავი','Rustavi','https://mreg.napr.gov.ge/v2/'),
 ('GE-KK-BOLNISI','GE-KK','municipality','ბოლნისი','Bolnisi','https://mreg.napr.gov.ge/v2/'),
 ('GE-KK-GARDABANI','GE-KK','municipality','გარდაბანი','Gardabani','https://mreg.napr.gov.ge/v2/'),
 ('GE-KK-DMANISI','GE-KK','municipality','დმანისი','Dmanisi','https://mreg.napr.gov.ge/v2/'),
 ('GE-KK-TETRITSKARO','GE-KK','municipality','თეთრიწყარო','Tetritskaro','https://mreg.napr.gov.ge/v2/'),
 ('GE-KK-MARNEULI','GE-KK','municipality','მარნეული','Marneuli','https://mreg.napr.gov.ge/v2/'),
 ('GE-KK-TSALKA','GE-KK','municipality','წალკა','Tsalka','https://mreg.napr.gov.ge/v2/'),
 ('GE-MM-DUSHETI','GE-MM','municipality','დუშეთი','Dusheti','https://mreg.napr.gov.ge/v2/'),
 ('GE-MM-TIANETI','GE-MM','municipality','თიანეთი','Tianeti','https://mreg.napr.gov.ge/v2/'),
 ('GE-MM-MTSKHETA','GE-MM','municipality','მცხეთა','Mtskheta','https://mreg.napr.gov.ge/v2/'),
 ('GE-MM-KAZBEGI','GE-MM','municipality','ყაზბეგი','Kazbegi','https://mreg.napr.gov.ge/v2/'),
 ('GE-RL-AMBROLAURI','GE-RL','municipality','ამბროლაური','Ambrolauri','https://mreg.napr.gov.ge/v2/'),
 ('GE-RL-LENTEKHI','GE-RL','municipality','ლენტეხი','Lentekhi','https://mreg.napr.gov.ge/v2/'),
 ('GE-RL-ONI','GE-RL','municipality','ონი','Oni','https://mreg.napr.gov.ge/v2/'),
 ('GE-RL-TSAGERI','GE-RL','municipality','ცაგერი','Tsageri','https://mreg.napr.gov.ge/v2/'),
 ('GE-SZ-POTI','GE-SZ','municipality','ფოთი','Poti','https://mreg.napr.gov.ge/v2/'),
 ('GE-SZ-ABASHA','GE-SZ','municipality','აბაშა','Abasha','https://mreg.napr.gov.ge/v2/'),
 ('GE-SZ-ZUGDIDI','GE-SZ','municipality','ზუგდიდი','Zugdidi','https://mreg.napr.gov.ge/v2/'),
 ('GE-SZ-MARTVILI','GE-SZ','municipality','მარტვილი','Martvili','https://mreg.napr.gov.ge/v2/'),
 ('GE-SZ-MESTIA','GE-SZ','municipality','მესტია','Mestia','https://mreg.napr.gov.ge/v2/'),
 ('GE-SZ-SENAKI','GE-SZ','municipality','სენაკი','Senaki','https://mreg.napr.gov.ge/v2/'),
 ('GE-SZ-CHKHOROTSKU','GE-SZ','municipality','ჩხოროწყუ','Chkhorotsku','https://mreg.napr.gov.ge/v2/'),
 ('GE-SZ-TSALENJIKHA','GE-SZ','municipality','წალენჯიხა','Tsalenjikha','https://mreg.napr.gov.ge/v2/'),
 ('GE-SZ-KHOBI','GE-SZ','municipality','ხობი','Khobi','https://mreg.napr.gov.ge/v2/'),
 ('GE-SJ-ADIGENI','GE-SJ','municipality','ადიგენი','Adigeni','https://mreg.napr.gov.ge/v2/'),
 ('GE-SJ-ASPINDZA','GE-SJ','municipality','ასპინძა','Aspindza','https://mreg.napr.gov.ge/v2/'),
 ('GE-SJ-AKHALKALAKI','GE-SJ','municipality','ახალქალაქი','Akhalkalaki','https://mreg.napr.gov.ge/v2/'),
 ('GE-SJ-AKHALTSIKHE','GE-SJ','municipality','ახალციხე','Akhaltsikhe','https://mreg.napr.gov.ge/v2/'),
 ('GE-SJ-BORJOMI','GE-SJ','municipality','ბორჯომი','Borjomi','https://mreg.napr.gov.ge/v2/'),
 ('GE-SJ-NINOTSMINDA','GE-SJ','municipality','ნინოწმინდა','Ninotsminda','https://mreg.napr.gov.ge/v2/'),
 ('GE-SK-GORI','GE-SK','municipality','გორი','Gori','https://mreg.napr.gov.ge/v2/'),
 ('GE-SK-KASPI','GE-SK','municipality','კასპი','Kaspi','https://mreg.napr.gov.ge/v2/'),
 ('GE-SK-KARELI','GE-SK','municipality','ქარელი','Kareli','https://mreg.napr.gov.ge/v2/'),
 ('GE-SK-KHASHURI','GE-SK','municipality','ხაშური','Khashuri','https://mreg.napr.gov.ge/v2/'),
 ('GE-TB-GLDANI','GE-TB','district','გლდანი','Gldani','https://www.tbilisi.gov.ge/contacts'),
 ('GE-TB-DIDUBE','GE-TB','district','დიდუბე','Didube','https://www.tbilisi.gov.ge/contacts'),
 ('GE-TB-VAKE','GE-TB','district','ვაკე','Vake','https://www.tbilisi.gov.ge/contacts'),
 ('GE-TB-ISANI','GE-TB','district','ისანი','Isani','https://www.tbilisi.gov.ge/contacts'),
 ('GE-TB-KRTSANISI','GE-TB','district','კრწანისი','Krtsanisi','https://www.tbilisi.gov.ge/contacts'),
 ('GE-TB-MTATSMINDA','GE-TB','district','მთაწმინდა','Mtatsminda','https://www.tbilisi.gov.ge/contacts'),
 ('GE-TB-NADZALADEVI','GE-TB','district','ნაძალადევი','Nadzaladevi','https://www.tbilisi.gov.ge/contacts'),
 ('GE-TB-SABURTALO','GE-TB','district','საბურთალო','Saburtalo','https://www.tbilisi.gov.ge/contacts'),
 ('GE-TB-SAMGORI','GE-TB','district','სამგორი','Samgori','https://www.tbilisi.gov.ge/contacts'),
 ('GE-TB-CHUGHURETI','GE-TB','district','ჩუღურეთი','Chughureti','https://www.tbilisi.gov.ge/contacts');

ALTER TABLE ertad.units
 ADD COLUMN territory_version integer NOT NULL DEFAULT 0 CHECK(territory_version>=0),
 ADD COLUMN operational_type text NOT NULL DEFAULT 'unclassified'
 CHECK(operational_type IN ('unclassified','region','locality','group','team')),
 ADD COLUMN geographic_area_id text REFERENCES ertad.geographic_areas(id);
CREATE INDEX units_geographic_area ON ertad.units(organization_id,geographic_area_id,id);
ALTER TABLE ertad.unit_reviews
 ADD COLUMN operational_type text NOT NULL DEFAULT 'unclassified'
 CHECK(operational_type IN ('unclassified','region','locality','group','team')),
 ADD COLUMN geographic_area_id text REFERENCES ertad.geographic_areas(id),
 ADD COLUMN parent_territory_version integer;
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='ertad.unit_reviews'::regclass
   AND contype='c' AND pg_get_constraintdef(oid) LIKE '%kind%'
 LOOP EXECUTE format('ALTER TABLE ertad.unit_reviews DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE ertad.unit_reviews ADD CHECK(kind IN ('create','rename','archive','restore','territory'));
ALTER TABLE ertad.unit_reviews ADD CHECK(
 (kind='create' AND target_id IS NULL AND target_version IS NULL AND original_name IS NULL)
 OR (kind IN ('rename','archive','restore','territory') AND target_id IS NOT NULL
   AND target_version IS NOT NULL AND target_version>=0 AND original_name IS NOT NULL
   AND (kind='rename' OR name=original_name)));

CREATE FUNCTION ertad.validate_unit_territory(org uuid,parent uuid,unit_type text,area text)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE p ertad.units; a ertad.geographic_areas;
BEGIN
 SELECT * INTO p FROM ertad.units WHERE organization_id=org AND id=parent AND status='active' AND kind='authority';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid territorial parent'; END IF;
 IF unit_type='unclassified' AND area IS NULL AND p.operational_type='unclassified' THEN RETURN; END IF;
 SELECT * INTO a FROM ertad.geographic_areas WHERE id=area AND active;
 IF NOT FOUND OR unit_type IS NULL OR NOT (
   (unit_type='region' AND p.parent_id IS NULL AND a.kind='region')
   OR (unit_type='locality' AND p.operational_type='region' AND a.parent_id=p.geographic_area_id AND a.kind IN ('municipality','district'))
   OR (unit_type='group' AND p.operational_type='locality' AND area=p.geographic_area_id)
   OR (unit_type='team' AND p.operational_type='group' AND area=p.geographic_area_id)
 ) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid territorial relationship'; END IF;
END $$;

CREATE FUNCTION ertad.unit_territory_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
   IF OLD.operational_type<>'unclassified' AND
     (NEW.operational_type,NEW.geographic_area_id) IS DISTINCT FROM (OLD.operational_type,OLD.geographic_area_id) THEN
     RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Territorial reassignment requires a separate lifecycle';
   END IF;
   IF (NEW.operational_type,NEW.geographic_area_id,NEW.parent_id) IS NOT DISTINCT FROM
      (OLD.operational_type,OLD.geographic_area_id,OLD.parent_id) THEN RETURN NEW; END IF;
 END IF;
 IF NEW.operational_type='unclassified' AND NEW.geographic_area_id IS NULL THEN RETURN NEW; END IF;
 IF NEW.kind<>'authority' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Invalid territorial unit kind'; END IF;
 PERFORM ertad.validate_unit_territory(NEW.organization_id,NEW.parent_id,NEW.operational_type,NEW.geographic_area_id);
 RETURN NEW;
END $$;
CREATE TRIGGER b_unit_territory BEFORE INSERT OR UPDATE ON ertad.units FOR EACH ROW EXECUTE FUNCTION ertad.unit_territory_guard();
CREATE OR REPLACE FUNCTION ertad.unit_version() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 NEW.territory_version:=OLD.territory_version+CASE WHEN (NEW.operational_type,NEW.geographic_area_id) IS DISTINCT FROM
 (OLD.operational_type,OLD.geographic_area_id) THEN 1 ELSE 0 END;
 NEW.version:=OLD.version+CASE WHEN (NEW.name,NEW.parent_id,NEW.status,NEW.kind,NEW.operational_type,NEW.geographic_area_id) IS DISTINCT FROM
 (OLD.name,OLD.parent_id,OLD.status,OLD.kind,OLD.operational_type,OLD.geographic_area_id) THEN 1 ELSE 0 END;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION ertad.unit_command(sid uuid,token text,op text,org uuid,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_column
DECLARE actor uuid; r ertad.unit_reviews; result jsonb; changed boolean:=false;
  target ertad.units; change_kind text; propose_permission text; approve_permission text;
  parent uuid; expiry timestamptz; page integer; view_name text; new_unit uuid; area text; unit_type text;
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
          decision_reason=trim(input->>'reason'),decision_at=clock_timestamp(),unit_id=new_unit WHERE organization_id=org AND id=r.id RETURNING * INTO r;
        changed:=true;
      END IF;
      result:=jsonb_build_object('id',r.id,'status',r.status,'unitId',r.unit_id);
    ELSE
      result:=(to_jsonb(r)-ARRAY['request_key','decision_key','parent_path'])||jsonb_build_object('parent_name',
        (SELECT name FROM ertad.units WHERE organization_id=org AND id=r.parent_id),
        'status',CASE WHEN r.status='pending' AND r.expires_at<=clock_timestamp() THEN 'expired' ELSE r.status END,
        'operational_type',r.operational_type,'geographic_area_id',r.geographic_area_id,
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
 IF r.kind IN ('create','territory') AND r.status IN ('pending','approved') THEN
   IF r.parent_territory_version IS NOT NULL AND r.parent_territory_version IS DISTINCT FROM
      (SELECT territory_version FROM ertad.units WHERE organization_id=org AND id=r.parent_id) THEN
     RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Territorial parent changed'; END IF;
   PERFORM ertad.validate_unit_territory(org,r.parent_id,r.operational_type,r.geographic_area_id);
 END IF;
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


REVOKE ALL ON ertad.geographic_areas FROM PUBLIC,ertad_app;
REVOKE ALL ON FUNCTION ertad.validate_unit_territory(uuid,uuid,text,text),ertad.unit_territory_guard() FROM PUBLIC,ertad_app;
