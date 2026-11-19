-- Completion review follows authority-bearing units, never position names.
ALTER TABLE ertad.work_assignments ADD COLUMN review_unit_id uuid;
ALTER TABLE ertad.work_assignments ADD FOREIGN KEY(organization_id,review_unit_id) REFERENCES ertad.units(organization_id,id);

CREATE FUNCTION ertad.work_member_review_unit(w ertad.work_items,member uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE managed ertad.units;
BEGIN
 IF ertad.work_manager(member,w) THEN
  SELECT u.* INTO managed FROM unnest(w.scope_path) WITH ORDINALITY path(id,n)
   JOIN ertad.units u ON u.organization_id=w.organization_id AND u.id=path.id
   WHERE ertad.review_has_scope(member,w.organization_id,u.id,'workitem.create')
    AND ertad.review_has_scope(member,w.organization_id,u.id,'workitem.read') ORDER BY path.n DESC LIMIT 1;
  IF FOUND THEN RETURN COALESCE(managed.parent_id,managed.id); END IF;
 END IF;
 RETURN w.unit_id;
END $$;

-- Pin the strongest observed review floor. Resignation cannot lower a stored floor.
UPDATE ertad.work_assignments a SET review_unit_id=ertad.work_member_review_unit(w,a.user_id)
 FROM ertad.work_items w WHERE w.organization_id=a.organization_id AND w.id=a.work_id;
ALTER TABLE ertad.work_assignments ALTER COLUMN review_unit_id SET NOT NULL;
CREATE FUNCTION ertad.work_pin_review_unit() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE w ertad.work_items; current_unit uuid;
BEGIN
 SELECT * INTO w FROM ertad.work_items WHERE organization_id=NEW.organization_id AND id=NEW.work_id;
 current_unit:=ertad.work_member_review_unit(w,NEW.user_id);
 IF TG_OP='UPDATE' THEN
  IF OLD.status='verified' THEN NEW.review_unit_id:=OLD.review_unit_id; RETURN NEW; END IF;
  IF array_position(w.scope_path,OLD.review_unit_id) IS NULL THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Review hierarchy unavailable';END IF;
  IF array_position(w.scope_path,OLD.review_unit_id)>array_position(w.scope_path,current_unit) THEN current_unit:=OLD.review_unit_id;END IF;
 END IF;
 NEW.review_unit_id:=current_unit;
 RETURN NEW;
END $$;
CREATE TRIGGER work_assignment_review_floor BEFORE INSERT OR UPDATE ON ertad.work_assignments
 FOR EACH ROW EXECUTE FUNCTION ertad.work_pin_review_unit();

CREATE FUNCTION ertad.work_review_unit(w ertad.work_items,member uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE pinned uuid;current_unit uuid;
BEGIN
 SELECT review_unit_id INTO pinned FROM ertad.work_assignments WHERE organization_id=w.organization_id AND work_id=w.id AND user_id=member;
 IF NOT FOUND OR array_position(w.scope_path,pinned) IS NULL THEN RETURN NULL;END IF;
 current_unit:=ertad.work_member_review_unit(w,member);
 RETURN CASE WHEN array_position(w.scope_path,pinned)>array_position(w.scope_path,current_unit) THEN pinned ELSE current_unit END;
END $$;
CREATE FUNCTION ertad.work_can_review_member(actor uuid,w ertad.work_items,member uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(actor<>member AND ertad.work_visible(actor,w)
  AND ertad.review_has_scope(actor,w.organization_id,w.unit_id,'workitem.verify')
  AND ertad.review_has_scope(member,w.organization_id,w.unit_id,'workitem.read')
  AND ertad.review_has_scope(member,w.organization_id,w.unit_id,'workitem.participate')
  AND ertad.review_has_scope(actor,w.organization_id,ertad.work_review_unit(w,member),'workitem.verify'),false);
$$;

ALTER FUNCTION ertad.work_authorize(uuid,uuid,text,jsonb) RENAME TO work_before_review_authorize;
CREATE FUNCTION ertad.work_authorize(actor uuid,org uuid,op text,input jsonb) RETURNS uuid
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE target uuid;w ertad.work_items;member uuid;
BEGIN
 target:=ertad.work_before_review_authorize(actor,org,op,input);
 IF op IN ('verify','return') THEN
  member:=(input->>'memberId')::uuid;
  IF actor=member THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Independent reviewer required';END IF;
  SELECT * INTO w FROM ertad.work_items WHERE organization_id=org AND id=(input->>'id')::uuid;
  IF NOT ertad.work_can_review_member(actor,w,member) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Review hierarchy unavailable';END IF;
 END IF;
 RETURN target;
END $$;

ALTER FUNCTION ertad.work_command(uuid,text,text,uuid,jsonb) RENAME TO work_before_review_command;
CREATE FUNCTION ertad.work_command(sid uuid,token text,op text,org uuid,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb;actor uuid;w ertad.work_items;assignments jsonb;
BEGIN
 result:=ertad.work_before_review_command(sid,token,op,org,input);
 IF op='detail' THEN
  actor:=ertad.review_identity(sid,token,false);
  SELECT * INTO w FROM ertad.work_items WHERE organization_id=org AND id=(input->>'id')::uuid;
  SELECT COALESCE(jsonb_agg(item||jsonb_build_object(
    'canReview',w.status='open' AND item->>'status'='submitted' AND ertad.work_can_review_member(actor,w,(item->>'memberId')::uuid),
    'reviewRoute',CASE WHEN ertad.work_review_unit(w,(item->>'memberId')::uuid)=w.unit_id THEN 'local' ELSE 'higher' END,
    'reviewUnitName',(SELECT name FROM ertad.units u WHERE u.organization_id=org AND u.id=ertad.work_review_unit(w,(item->>'memberId')::uuid)
     AND ertad.review_has_scope(actor,org,u.id,'unit.read'))
   ) ORDER BY n),'[]') INTO assignments FROM jsonb_array_elements(result->'data'->'assignments') WITH ORDINALITY x(item,n);
  result:=jsonb_set(result,'{data,assignments}',assignments);
 END IF;
 RETURN result;
END $$;

REVOKE ALL ON FUNCTION ertad.work_member_review_unit(ertad.work_items,uuid),ertad.work_pin_review_unit(),
 ertad.work_review_unit(ertad.work_items,uuid),ertad.work_can_review_member(uuid,ertad.work_items,uuid),
 ertad.work_before_review_authorize(uuid,uuid,text,jsonb),ertad.work_authorize(uuid,uuid,text,jsonb),
 ertad.work_before_review_command(uuid,text,text,uuid,jsonb),ertad.work_command(uuid,text,text,uuid,jsonb) FROM PUBLIC,ertad_app;
GRANT EXECUTE ON FUNCTION ertad.work_command(uuid,text,text,uuid,jsonb) TO ertad_app;

CREATE OR REPLACE FUNCTION ertad.inbox_work_action(actor uuid,w ertad.work_items) RETURNS text
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
BEGIN
 IF w.status='offered' AND ertad.work_manager(actor,w) THEN RETURN 'accept'; END IF;
 IF w.status<>'open' THEN RETURN ''; END IF;
 IF ertad.review_has_scope(actor,w.organization_id,w.unit_id,'workitem.verify') AND (
  EXISTS(SELECT 1 FROM ertad.work_assignments WHERE organization_id=w.organization_id AND work_id=w.id AND status='submitted' AND ertad.work_can_review_member(actor,w,user_id))
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
