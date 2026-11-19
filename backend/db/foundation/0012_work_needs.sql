-- Work needs and independently verified qualifications; existing task transaction owns writes.
ALTER TABLE ertad.permission_grants DROP CONSTRAINT permission_grants_permission_check;
ALTER TABLE ertad.permission_grants ADD CONSTRAINT permission_grants_permission_check CHECK
 (permission IN ('unit.read','workitem.create','workitem.verify','workitem.read','workitem.participate',
 'membership.propose','membership.approve','unit.propose','unit.approve',
 'decision.read','decision.manage','decision.publish','decision.vote','qualification.verify'));

CREATE TABLE ertad.qualification_definitions (
 organization_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), unit_id uuid NOT NULL,
 title text NOT NULL CHECK(length(trim(title)) BETWEEN 3 AND 100),
 PRIMARY KEY(organization_id,id), FOREIGN KEY(organization_id,unit_id) REFERENCES ertad.units(organization_id,id),
 UNIQUE(organization_id,unit_id,title)
);
CREATE TABLE ertad.qualification_claims (
 organization_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), work_id uuid NOT NULL,
 qualification_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES ertad.member_users(id),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verified','rejected','revoked')),
 reference text NOT NULL CHECK(length(reference) BETWEEN 3 AND 500),
 reviewer_id uuid REFERENCES ertad.member_users(id), valid_until timestamptz,
 review_note text NOT NULL DEFAULT '' CHECK(length(review_note)<=1000),
 PRIMARY KEY(organization_id,id),
 FOREIGN KEY(organization_id,work_id) REFERENCES ertad.work_items(organization_id,id),
 FOREIGN KEY(organization_id,qualification_id) REFERENCES ertad.qualification_definitions(organization_id,id),
 CHECK(reviewer_id IS NULL OR reviewer_id<>user_id),
 CHECK(status<>'verified' OR (reviewer_id IS NOT NULL AND valid_until IS NOT NULL AND isfinite(valid_until)))
);
CREATE UNIQUE INDEX qualification_pending ON ertad.qualification_claims(organization_id,qualification_id,user_id) WHERE status='pending';
CREATE INDEX qualification_eligibility ON ertad.qualification_claims(organization_id,user_id,qualification_id,status,valid_until);
CREATE TABLE ertad.work_needs (
 organization_id uuid NOT NULL, work_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
 kind text NOT NULL CHECK(kind IN ('people','resource','service')),
 title text NOT NULL CHECK(length(trim(title)) BETWEEN 3 AND 160),
 quantity numeric(12,3) NOT NULL CHECK(quantity>0 AND quantity<=1000000),
 unit_label text NOT NULL CHECK(length(trim(unit_label)) BETWEEN 1 AND 40),
 gate text NOT NULL CHECK(gate IN ('optional','start','complete')),
 owner_id uuid NOT NULL REFERENCES ertad.member_users(id), deadline timestamptz NOT NULL CHECK(isfinite(deadline)),
 cancelled boolean NOT NULL DEFAULT false,
 source_need_id uuid,
 PRIMARY KEY(organization_id,work_id,id), UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,work_id) REFERENCES ertad.work_items(organization_id,id),
 FOREIGN KEY(organization_id,source_need_id) REFERENCES ertad.work_needs(organization_id,id),
 CHECK(kind<>'people' OR (quantity=trunc(quantity) AND quantity<=100))
);
CREATE TABLE ertad.work_need_qualifications (
 organization_id uuid NOT NULL, need_id uuid NOT NULL, qualification_id uuid NOT NULL,
 PRIMARY KEY(organization_id,need_id,qualification_id),
 FOREIGN KEY(organization_id,need_id) REFERENCES ertad.work_needs(organization_id,id),
 FOREIGN KEY(organization_id,qualification_id) REFERENCES ertad.qualification_definitions(organization_id,id)
);
CREATE TABLE ertad.work_provisions (
 organization_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), need_id uuid NOT NULL,
 user_id uuid NOT NULL REFERENCES ertad.member_users(id), quantity numeric(12,3) NOT NULL CHECK(quantity>0 AND quantity<=1000000),
 status text NOT NULL DEFAULT 'pledged' CHECK(status IN ('pledged','confirmed','withdrawn','returned','rejected')),
 verifier_id uuid REFERENCES ertad.member_users(id), note text NOT NULL CHECK(length(note)<=1000),
 PRIMARY KEY(organization_id,id), FOREIGN KEY(organization_id,need_id) REFERENCES ertad.work_needs(organization_id,id),
 CHECK(verifier_id IS NULL OR verifier_id<>user_id)
);
CREATE INDEX work_provision_totals ON ertad.work_provisions(organization_id,need_id,status);
ALTER TABLE ertad.work_assignments ADD COLUMN need_id uuid;
ALTER TABLE ertad.work_assignments ADD FOREIGN KEY(organization_id,work_id,need_id) REFERENCES ertad.work_needs(organization_id,work_id,id);

CREATE FUNCTION ertad.work_qualified(w ertad.work_items,member uuid,need uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT NOT EXISTS(SELECT 1 FROM ertad.work_need_qualifications q WHERE q.organization_id=w.organization_id AND q.need_id=need
 AND NOT EXISTS(SELECT 1 FROM ertad.qualification_claims c JOIN ertad.work_items source ON source.organization_id=c.organization_id AND source.id=c.work_id
 WHERE c.organization_id=q.organization_id AND c.qualification_id=q.qualification_id AND c.user_id=member AND c.status='verified'
 AND c.valid_until>clock_timestamp() AND ertad.unit_path(source.organization_id,source.unit_id)=source.scope_path))
$$;
CREATE FUNCTION ertad.work_need_confirmed(n ertad.work_needs,completed boolean DEFAULT false,actor uuid DEFAULT NULL) RETURNS numeric
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
BEGIN RETURN (SELECT CASE WHEN n.kind='people' THEN (SELECT count(*) FROM ertad.work_assignments a JOIN ertad.work_items own_work ON own_work.organization_id=a.organization_id AND own_work.id=a.work_id
 WHERE a.organization_id=n.organization_id AND a.need_id=n.id AND
 CASE WHEN completed THEN a.status='verified' ELSE a.status='verified' OR (a.status IN ('assigned','in_progress','submitted') AND ertad.work_qualified(own_work,a.user_id,n.id)) END)
 + COALESCE((SELECT sum(ertad.work_need_confirmed(child,completed,actor)) FROM ertad.work_needs child JOIN ertad.work_items w ON w.organization_id=child.organization_id AND w.id=child.work_id
 WHERE child.organization_id=n.organization_id AND child.source_need_id=n.id AND NOT child.cancelled AND w.status<>'cancelled' AND (actor IS NULL OR ertad.work_visible(actor,w))),0)
 ELSE (SELECT COALESCE(sum(p.quantity),0) FROM ertad.work_provisions p WHERE p.organization_id=n.organization_id AND p.need_id=n.id AND p.status='confirmed') END); END
$$;
CREATE FUNCTION ertad.work_need_allocated(n ertad.work_needs) RETURNS numeric
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT (SELECT count(*) FROM ertad.work_assignments a WHERE a.organization_id=n.organization_id AND a.need_id=n.id AND a.status IN ('assigned','in_progress','submitted','verified'))
 + COALESCE((SELECT sum(child.quantity) FROM ertad.work_needs child JOIN ertad.work_items w ON w.organization_id=child.organization_id AND w.id=child.work_id WHERE child.organization_id=n.organization_id AND child.source_need_id=n.id AND NOT child.cancelled AND w.status<>'cancelled'),0)
$$;
CREATE FUNCTION ertad.work_need_delegate(actor uuid,parent ertad.work_items,child ertad.work_items,need uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE n ertad.work_needs; new_id uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM ertad.work_needs WHERE organization_id=parent.organization_id AND work_id=parent.id AND kind='people' AND NOT cancelled) THEN
  IF need IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid parent role'; END IF; RETURN;
 END IF;
 SELECT * INTO n FROM ertad.work_needs WHERE organization_id=parent.organization_id AND work_id=parent.id AND id=need AND kind='people' AND NOT cancelled;
 IF NOT FOUND OR ertad.work_need_allocated(n)+child.capacity>n.quantity THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Select a role with sufficient unallocated places'; END IF;
 INSERT INTO ertad.work_needs(organization_id,work_id,kind,title,quantity,unit_label,gate,owner_id,deadline,source_need_id)
 VALUES(child.organization_id,child.id,'people',n.title,child.capacity,n.unit_label,n.gate,actor,least(n.deadline,child.deadline),n.id) RETURNING id INTO new_id;
 INSERT INTO ertad.work_need_qualifications SELECT organization_id,new_id,qualification_id FROM ertad.work_need_qualifications WHERE organization_id=n.organization_id AND need_id=n.id;
END $$;
CREATE FUNCTION ertad.work_need_gate(w ertad.work_items,stage text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM ertad.work_needs n WHERE n.organization_id=w.organization_id AND n.work_id=w.id AND NOT n.cancelled
 AND (n.gate=stage OR (stage='complete' AND n.gate='start')) AND ertad.work_need_confirmed(n,stage='complete')<n.quantity) THEN
 RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Mandatory need remains unfulfilled'; END IF;
END $$;
CREATE FUNCTION ertad.work_assignment_qualification(w ertad.work_items,member uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE need uuid;
BEGIN
 SELECT need_id INTO need FROM ertad.work_assignments WHERE organization_id=w.organization_id AND work_id=w.id AND user_id=member;
 IF need IS NOT NULL AND NOT ertad.work_qualified(w,member,need) THEN
 RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Current verified qualification required'; END IF;
END $$;
CREATE FUNCTION ertad.work_needs_detail(actor uuid,w ertad.work_items) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('canVerifyQualifications',ertad.review_has_scope(actor,w.organization_id,w.unit_id,'qualification.verify'),
 'qualificationCatalog',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',q.id,'title',q.title) ORDER BY q.title,q.id)
 FROM ertad.qualification_definitions q WHERE q.organization_id=w.organization_id AND q.unit_id=ANY(w.scope_path)),'[]'),
 'qualificationClaims',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id,'qualificationId',c.qualification_id,'memberId',c.user_id,'status',c.status,'reference',c.reference,'reviewNote',c.review_note,'validUntil',c.valid_until) ORDER BY c.id)
 FROM ertad.qualification_claims c WHERE c.organization_id=w.organization_id AND c.work_id=w.id AND (c.user_id=actor OR ertad.review_has_scope(actor,w.organization_id,w.unit_id,'qualification.verify'))),'[]'),
 'needs',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',n.id,'kind',n.kind,'title',n.title,'quantity',n.quantity::text,'unitLabel',n.unit_label,'gate',n.gate,'ownerId',n.owner_id,'deadline',n.deadline,'cancelled',n.cancelled,
 'confirmed',ertad.work_need_confirmed(n,false,actor)::text,'remaining',greatest(n.quantity-ertad.work_need_confirmed(n,false,actor),0)::text,'qualified',ertad.work_qualified(w,actor,n.id),
 'qualificationIds',COALESCE((SELECT jsonb_agg(q.qualification_id) FROM ertad.work_need_qualifications q WHERE q.organization_id=n.organization_id AND q.need_id=n.id),'[]'),
 'pledged',COALESCE((SELECT sum(p.quantity)::text FROM ertad.work_provisions p WHERE p.organization_id=n.organization_id AND p.need_id=n.id AND p.status='pledged'),'0'),
 'provisions',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'memberId',p.user_id,'quantity',p.quantity::text,'status',p.status,'note',p.note) ORDER BY p.id) FROM ertad.work_provisions p WHERE p.organization_id=n.organization_id AND p.need_id=n.id
 AND (p.user_id=actor OR ertad.work_manager(actor,w) OR ertad.review_has_scope(actor,w.organization_id,w.unit_id,'workitem.verify'))),'[]')) ORDER BY n.id)
 FROM ertad.work_needs n WHERE n.organization_id=w.organization_id AND n.work_id=w.id),'[]'))
$$;

CREATE FUNCTION ertad.work_needs_change(actor uuid,w ertad.work_items,op text,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE n ertad.work_needs; p ertad.work_provisions; c ertad.qualification_claims; q uuid; ids uuid[]; amount numeric; newid uuid; note text:=trim(COALESCE(input->>'note',''));
BEGIN
 IF w.status<>'open' AND op NOT IN ('qualification_revoke','provision_return') THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Open task required'; END IF;
 IF op='qualification_define' THEN
  IF (SELECT count(*) FROM ertad.qualification_definitions WHERE organization_id=w.organization_id AND unit_id=w.unit_id)>=100 THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Definition limit'; END IF;
  INSERT INTO ertad.qualification_definitions(organization_id,unit_id,title) VALUES(w.organization_id,w.unit_id,trim(input->>'title')) RETURNING id INTO newid;
 ELSIF op='qualification_claim' THEN
  IF NOT EXISTS(SELECT 1 FROM ertad.qualification_definitions WHERE organization_id=w.organization_id AND id=(input->>'qualificationId')::uuid AND unit_id=ANY(w.scope_path)) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Qualification unavailable'; END IF;
  IF (SELECT count(*) FROM ertad.qualification_claims WHERE organization_id=w.organization_id AND work_id=w.id)>=100 THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Claim limit'; END IF;
  INSERT INTO ertad.qualification_claims(organization_id,work_id,qualification_id,user_id,reference) VALUES(w.organization_id,w.id,(input->>'qualificationId')::uuid,actor,trim(input->>'reference')) RETURNING id INTO newid;
 ELSIF op IN ('qualification_verify','qualification_reject','qualification_revoke') THEN
  SELECT * INTO c FROM ertad.qualification_claims WHERE organization_id=w.organization_id AND work_id=w.id AND id=(input->>'claimId')::uuid;
  IF NOT FOUND OR c.user_id=actor OR NOT ertad.work_visible(c.user_id,w) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Independent eligible claimant required'; END IF;
  IF (op='qualification_revoke' AND c.status<>'verified') OR (op<>'qualification_revoke' AND c.status<>'pending') THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Claim state changed'; END IF;
  IF length(note)<3 OR (op='qualification_verify' AND ((input->>'validUntil') IS NULL OR NOT isfinite((input->>'validUntil')::timestamptz) OR (input->>'validUntil')::timestamptz<=clock_timestamp() OR (input->>'validUntil')::timestamptz>clock_timestamp()+interval '5 years')) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Reason and bounded validity required'; END IF;
  UPDATE ertad.qualification_claims SET status=CASE op WHEN 'qualification_verify' THEN 'verified' WHEN 'qualification_reject' THEN 'rejected' ELSE 'revoked' END, reviewer_id=actor,review_note=note,
   valid_until=CASE WHEN op='qualification_verify' THEN (input->>'validUntil')::timestamptz ELSE valid_until END WHERE organization_id=w.organization_id AND id=c.id;
  newid:=c.id;
 ELSIF op='need_create' THEN
  IF w.deadline<=clock_timestamp() OR EXISTS(SELECT 1 FROM ertad.work_assignments WHERE organization_id=w.organization_id AND work_id=w.id) OR EXISTS(SELECT 1 FROM ertad.work_items WHERE organization_id=w.organization_id AND parent_id=w.id AND status<>'cancelled') THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Needs freeze when participation begins'; END IF;
  IF (SELECT count(*) FROM ertad.work_needs WHERE organization_id=w.organization_id AND work_id=w.id)>=20 THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Need limit'; END IF;
  IF COALESCE(input->>'quantity','') !~ '^[0-9]{1,7}(\.[0-9]{1,3})?$' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Exact quantity required'; END IF;
  amount:=(input->>'quantity')::numeric;
  IF input->>'kind'='people' AND amount+COALESCE((SELECT sum(quantity) FROM ertad.work_needs WHERE organization_id=w.organization_id AND work_id=w.id AND kind='people' AND NOT cancelled),0)>w.capacity THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Role slots exceed task capacity'; END IF;
  IF NOT ertad.work_manager((input->>'memberId')::uuid,w) OR ((input->>'memberId')::uuid<>actor AND NOT ertad.work_local_manager((input->>'memberId')::uuid,w)) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Eligible need owner required'; END IF;
  IF (input->>'deadline')::timestamptz<=clock_timestamp() OR (input->>'deadline')::timestamptz>w.deadline THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Need deadline outside task'; END IF;
  SELECT COALESCE(array_agg(value::uuid),'{}') INTO ids FROM jsonb_array_elements_text(COALESCE(input->'qualificationIds','[]'));
  IF cardinality(ids)>10 OR (cardinality(ids)>0 AND input->>'kind'<>'people') OR EXISTS(SELECT 1 FROM unnest(ids) v WHERE NOT EXISTS(SELECT 1 FROM ertad.qualification_definitions d WHERE d.organization_id=w.organization_id AND d.id=v AND d.unit_id=ANY(w.scope_path))) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid qualifications'; END IF;
  INSERT INTO ertad.work_needs(organization_id,work_id,kind,title,quantity,unit_label,gate,owner_id,deadline)
   VALUES(w.organization_id,w.id,input->>'kind',trim(input->>'title'),amount,trim(input->>'unitLabel'),input->>'gate',(input->>'memberId')::uuid,(input->>'deadline')::timestamptz) RETURNING id INTO newid;
  INSERT INTO ertad.work_need_qualifications SELECT w.organization_id,newid,v FROM unnest(ids) v;
 ELSE
  IF op IN ('need_cancel','provision_offer') THEN
   SELECT * INTO n FROM ertad.work_needs WHERE organization_id=w.organization_id AND work_id=w.id AND id=(input->>'needId')::uuid;
  ELSE
   SELECT * INTO p FROM ertad.work_provisions WHERE organization_id=w.organization_id AND id=(input->>'provisionId')::uuid;
   SELECT * INTO n FROM ertad.work_needs WHERE organization_id=w.organization_id AND work_id=w.id AND id=p.need_id;
  END IF;
  IF n.id IS NULL OR n.cancelled THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Need unavailable'; END IF;
  newid:=n.id;
  IF op='need_cancel' THEN
   IF EXISTS(SELECT 1 FROM ertad.work_needs cn JOIN ertad.work_items cw ON cw.organization_id=cn.organization_id AND cw.id=cn.work_id WHERE cn.organization_id=w.organization_id AND cn.source_need_id=n.id AND cw.status<>'cancelled') THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Allocated child roles must be settled first'; END IF;
   IF length(note)<3 OR EXISTS(SELECT 1 FROM ertad.work_assignments WHERE organization_id=w.organization_id AND work_id=w.id) OR EXISTS(SELECT 1 FROM ertad.work_provisions WHERE organization_id=w.organization_id AND need_id=n.id AND status IN ('pledged','confirmed')) THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Cannot discard active need'; END IF;
   UPDATE ertad.work_needs SET cancelled=true WHERE organization_id=w.organization_id AND id=n.id;
  ELSIF op='provision_offer' THEN
   IF n.kind='people' OR n.deadline<=clock_timestamp() OR COALESCE(input->>'quantity','') !~ '^[0-9]{1,7}(\.[0-9]{1,3})?$' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid provision'; END IF;
   amount:=(input->>'quantity')::numeric;
   IF amount>n.quantity OR (SELECT count(*) FROM ertad.work_provisions WHERE organization_id=w.organization_id AND need_id=n.id)>=100 THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Provision limit'; END IF;
   INSERT INTO ertad.work_provisions(organization_id,need_id,user_id,quantity,note) VALUES(w.organization_id,n.id,actor,amount,note) RETURNING id INTO newid;
  ELSIF op='provision_confirm' THEN
   IF p.user_id=actor OR NOT ertad.work_visible(p.user_id,w) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Independent current supplier required'; END IF;
   IF p.status<>'pledged' OR ertad.work_need_confirmed(n)+p.quantity>n.quantity OR length(note)<3 THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Provision cannot be confirmed'; END IF;
   UPDATE ertad.work_provisions SET status='confirmed',verifier_id=actor WHERE organization_id=w.organization_id AND id=p.id;
  ELSIF op='provision_withdraw' THEN
   IF p.user_id<>actor THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Own pledge required'; END IF;
   IF p.status<>'pledged' THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Only unconfirmed pledges can be withdrawn'; END IF;
   UPDATE ertad.work_provisions SET status='withdrawn' WHERE organization_id=w.organization_id AND id=p.id;
  ELSIF op IN ('provision_return','provision_reject') THEN
   IF length(note)<3 OR (op='provision_return' AND p.status<>'confirmed') OR (op='provision_reject' AND p.status<>'pledged') THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Provision state changed'; END IF;
   UPDATE ertad.work_provisions SET status=CASE op WHEN 'provision_return' THEN 'returned' ELSE 'rejected' END WHERE organization_id=w.organization_id AND id=p.id;
  ELSE RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Unknown need operation'; END IF;
 END IF;
 RETURN jsonb_build_object('recordId',newid);
END $$;

REVOKE ALL ON ertad.qualification_definitions,ertad.qualification_claims,ertad.work_needs,ertad.work_need_qualifications,ertad.work_provisions FROM PUBLIC,ertad_app;
REVOKE ALL ON FUNCTION ertad.work_qualified(ertad.work_items,uuid,uuid),ertad.work_need_confirmed(ertad.work_needs,boolean,uuid),ertad.work_need_gate(ertad.work_items,text),ertad.work_assignment_qualification(ertad.work_items,uuid),ertad.work_needs_detail(uuid,ertad.work_items),ertad.work_needs_change(uuid,ertad.work_items,text,jsonb),ertad.work_need_allocated(ertad.work_needs),ertad.work_need_delegate(uuid,ertad.work_items,ertad.work_items,uuid) FROM PUBLIC;




-- Command integration follows.
CREATE OR REPLACE FUNCTION ertad.work_authorize(actor uuid,org uuid,op text,input jsonb) RETURNS uuid
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE w ertad.work_items; target uuid; permission text;
BEGIN
 IF op='create' THEN target:=(input->>'unitId')::uuid;
 ELSE
  SELECT * INTO w FROM ertad.work_items WHERE organization_id=org AND id=(input->>'id')::uuid;
  IF NOT FOUND OR NOT ertad.work_visible(actor,w) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
  target:=w.unit_id;
 END IF;
 permission:=CASE WHEN op IN ('qualification_verify','qualification_reject','qualification_revoke') THEN 'qualification.verify' WHEN op IN ('qualification_claim','provision_offer','provision_withdraw') THEN 'workitem.participate' WHEN op='provision_confirm' THEN 'workitem.verify' WHEN op IN ('apply','withdraw','start','progress','submit') THEN 'workitem.participate'
 WHEN op IN ('verify','return','criterion_verify','criterion_return') THEN 'workitem.verify' WHEN op IN ('detail','ack','criterion_submit','block') THEN 'workitem.read' ELSE 'workitem.create' END;
 IF NOT ertad.review_has_scope(actor,org,target,'workitem.read') OR NOT ertad.review_has_scope(actor,org,target,permission) THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 IF op IN ('assign','reserve','verify','return') AND (NOT ertad.review_has_scope((input->>'memberId')::uuid,org,target,'workitem.participate')
  OR NOT ertad.review_has_scope((input->>'memberId')::uuid,org,target,'workitem.read')) THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Participant no longer eligible'; END IF;
 IF op IN ('criterion_submit','block') AND NOT ertad.work_contributor(actor,w) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Active contributor required'; END IF;
 IF op IN ('coordinator','block','block_update') AND input->>'memberId' IS NOT NULL AND (NOT ertad.work_manager((input->>'memberId')::uuid,w) OR ((input->>'memberId')::uuid<>actor AND NOT ertad.work_local_manager((input->>'memberId')::uuid,w))) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Scoped manager required'; END IF;
 IF op='criterion_verify' AND EXISTS(SELECT 1 FROM ertad.work_criteria c WHERE c.organization_id=org AND c.work_id=w.id AND c.id=(input->>'criterionId')::uuid AND (c.submitted_by=actor OR NOT ertad.work_contributor(c.submitted_by,w))) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Independent current contributor required'; END IF;
 IF op IN ('qualification_verify','qualification_reject','qualification_revoke') AND EXISTS(SELECT 1 FROM ertad.qualification_claims c WHERE c.organization_id=org AND c.work_id=w.id AND c.id=(input->>'claimId')::uuid AND (c.user_id=actor OR NOT ertad.work_visible(c.user_id,w))) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Independent eligible claimant required'; END IF;
 IF op IN ('assign','reserve','start','submit','verify') THEN PERFORM ertad.work_assignment_qualification(w,CASE WHEN op IN ('start','submit') THEN actor ELSE (input->>'memberId')::uuid END); END IF;
 IF op='provision_confirm' AND EXISTS(SELECT 1 FROM ertad.work_provisions p WHERE p.organization_id=org AND p.id=(input->>'provisionId')::uuid AND (p.user_id=actor OR NOT ertad.work_visible(p.user_id,w))) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Independent current supplier required'; END IF;
 RETURN target;
END $$;

CREATE OR REPLACE FUNCTION ertad.work_command(sid uuid,token text,op text,org uuid,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_column
DECLARE actor uuid; w ertad.work_items; child ertad.work_items; a ertad.work_assignments; receipt ertad.work_commands;
 result jsonb; mutation boolean; changed boolean:=false; target uuid; subject uuid; note text; n integer; next_status text; event_details jsonb:='{}';
BEGIN
 IF op NOT IN ('contexts','units','list','detail','create','delegate','accept','decline','cancel','complete','apply','reserve','assign','reject','withdraw','start','progress','submit','return','verify','no_show','ack','overview','coordinator','criteria','criterion_submit','criterion_verify','criterion_return','block','block_update','resolve_block','qualification_define','qualification_claim','qualification_verify','qualification_reject','qualification_revoke','need_create','need_cancel','provision_offer','provision_confirm','provision_withdraw','provision_return','provision_reject') THEN
  RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid operation'; END IF;
 mutation:=op NOT IN ('contexts','units','list','detail','overview');
 actor:=ertad.review_identity(sid,token,mutation AND op<>'ack');
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
 PERFORM ertad.review_identity(sid,token,mutation AND op<>'ack');
 IF op='contexts' THEN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',o.id,'name',o.name)),'[]') INTO result FROM ertad.organizations o
  WHERE o.status='active' AND EXISTS(SELECT 1 FROM ertad.units u WHERE u.organization_id=o.id AND ertad.review_has_scope(actor,o.id,u.id,'workitem.read'));
 ELSIF op='units' THEN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',u.id,'name',u.name,'parentId',u.parent_id,
   'canCreate',ertad.review_has_scope(actor,org,u.id,'workitem.create')) ORDER BY u.name,u.id),'[]') INTO result
  FROM ertad.units u WHERE u.organization_id=org AND u.kind='authority' AND ertad.review_has_scope(actor,org,u.id,'workitem.read');
 ELSIF op='overview' THEN
  target:=(input->>'unitId')::uuid;
  IF target IS NOT NULL AND NOT ertad.review_has_scope(actor,org,target,'workitem.read') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
  result:=ertad.work_overview(actor,org,NULL,target);
 ELSIF op='list' THEN
  n:=COALESCE((input->>'page')::integer,1);
  IF n NOT BETWEEN 1 AND 1000 OR COALESCE(input->>'view','open') NOT IN ('open','offered','completed','cancelled','mine','inbox','blocked','overdue','needs_review') OR length(COALESCE(input->>'search',''))>80 THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid filter'; END IF;
  target:=(input->>'unitId')::uuid;
  IF target IS NOT NULL AND NOT ertad.review_has_scope(actor,org,target,'workitem.read') THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
  WITH visible AS (SELECT w.* FROM ertad.work_items w WHERE w.organization_id=org AND ertad.work_visible(actor,w) AND (target IS NULL OR target=ANY(w.scope_path))
   AND position(lower(COALESCE(input->>'search','')) in lower(w.title))>0
   AND CASE WHEN input->>'view'='mine' THEN EXISTS(SELECT 1 FROM ertad.work_assignments a WHERE a.organization_id=org AND a.work_id=w.id AND a.user_id=actor)
    WHEN input->>'view'='inbox' THEN EXISTS(SELECT 1 FROM ertad.work_notifications nt WHERE nt.organization_id=org AND nt.work_id=w.id AND nt.recipient_id=actor AND nt.read_at IS NULL)
    WHEN input->>'view'='blocked' THEN w.status IN ('offered','open') AND EXISTS(SELECT 1 FROM ertad.work_blockers b WHERE b.organization_id=org AND b.work_id=w.id AND b.resolved_at IS NULL)
    WHEN input->>'view'='overdue' THEN w.status IN ('offered','open') AND w.deadline<=clock_timestamp()
    WHEN input->>'view'='needs_review' THEN w.status='open' AND (ertad.work_tracking(w)->>'pendingReview')::int>0
    ELSE w.status=COALESCE(input->>'view','open') END),
   paged AS (SELECT * FROM visible ORDER BY created_at DESC,id LIMIT 25 OFFSET (n-1)*25)
  SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(ertad.work_view(actor,paged::ertad.work_items) ORDER BY created_at DESC,id) FROM paged),'[]'),
   'total',(SELECT count(*) FROM visible),'page',n,'pageSize',25) INTO result;
 ELSE
  target:=ertad.work_authorize(actor,org,op,input);
  IF op<>'create' THEN SELECT * INTO w FROM ertad.work_items WHERE organization_id=org AND id=(input->>'id')::uuid; END IF;
  IF mutation AND op<>'ack' THEN
   SELECT * INTO receipt FROM ertad.work_commands WHERE organization_id=org AND actor_id=actor AND key=(input->>'key')::uuid;
   IF FOUND THEN
    IF receipt.operation<>op OR receipt.payload<>input-'key' THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Retry conflict'; END IF;
    RETURN jsonb_build_object('data',receipt.response,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'workId',receipt.work_id,'changed',false));
   END IF;
   IF op<>'create' AND w.version IS DISTINCT FROM (input->>'version')::integer THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Stale version'; END IF;
  END IF;
  IF op='detail' THEN
   result:=ertad.work_view(actor,w)||ertad.work_tracking_detail(actor,w)||ertad.work_needs_detail(actor,w)||jsonb_build_object(
    'assignments',COALESCE((SELECT jsonb_agg(jsonb_build_object('memberId',a.user_id,'needId',a.need_id,'qualified',ertad.work_qualified(w,a.user_id,a.need_id),'status',a.status,'progress',a.progress) ORDER BY a.user_id)
     FROM ertad.work_assignments a WHERE a.organization_id=org AND a.work_id=w.id AND (a.user_id=actor OR ertad.review_has_scope(actor,org,target,'workitem.create') OR ertad.review_has_scope(actor,org,target,'workitem.verify'))),'[]'),
    'events',COALESCE((SELECT jsonb_agg(jsonb_build_object('version',e.version,'action',e.action,'at',e.created_at,'note',e.note,'progress',e.progress,'actorId',e.actor_id,'subjectId',e.subject_id,'details',e.details) ORDER BY e.version DESC)
     FROM (SELECT * FROM ertad.work_events e WHERE e.organization_id=org AND e.work_id=w.id
      AND (e.subject_id IS NULL OR e.subject_id=actor OR ertad.review_has_scope(actor,org,target,'workitem.create') OR ertad.review_has_scope(actor,org,target,'workitem.verify')) ORDER BY version DESC LIMIT 100) e),'[]'),
    'children',COALESCE((SELECT jsonb_agg(ertad.work_view(actor,c) ORDER BY c.created_at,c.id) FROM ertad.work_items c WHERE c.organization_id=org AND c.parent_id=w.id AND ertad.work_visible(actor,c)),'[]'));
  ELSIF op='ack' THEN
   UPDATE ertad.work_notifications SET read_at=clock_timestamp() WHERE organization_id=org AND work_id=w.id AND recipient_id=actor AND version<=(input->>'version')::integer AND read_at IS NULL;
   result:=jsonb_build_object('id',w.id);
  ELSE
   note:=trim(COALESCE(input->>'note',''));
   IF length(note)>1000 OR (op IN ('decline','cancel','reject','return','no_show') AND length(note)<3) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Reason required'; END IF;
   IF op IN ('create','delegate') THEN
    IF op='create' AND NOT EXISTS(SELECT 1 FROM ertad.units WHERE organization_id=org AND id=target AND kind='authority' AND status='active') THEN
     RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Active authority unit required'; END IF;
    IF length(trim(COALESCE(input->>'title',''))) NOT BETWEEN 3 AND 160 OR length(COALESCE(input->>'description',''))>3000
     OR length(trim(COALESCE(input->>'roleLabel',''))) NOT BETWEEN 1 AND 100 OR COALESCE((input->>'capacity')::integer,0) NOT BETWEEN 1 AND 100
     OR (input->>'deadline') IS NULL OR (input->>'deadline')::timestamptz<=clock_timestamp() OR (input->>'deadline')::timestamptz>clock_timestamp()+interval '365 days' THEN
     RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid definition'; END IF;
    IF op='delegate' THEN
     IF w.status<>'open' OR w.deadline<=clock_timestamp() OR ertad.work_used(w)+(input->>'capacity')::integer>w.capacity
      OR (input->>'deadline')::timestamptz>w.deadline THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Allocation unavailable'; END IF;
     target:=(input->>'unitId')::uuid;
     IF NOT EXISTS(SELECT 1 FROM ertad.units WHERE organization_id=org AND id=target AND parent_id=w.unit_id AND status='active' AND kind='authority')
      OR NOT ertad.review_has_scope(actor,org,target,'workitem.create') OR NOT ertad.review_has_scope(actor,org,target,'workitem.read') THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Child scope required'; END IF;
    END IF;
    INSERT INTO ertad.work_items(organization_id,unit_id,parent_id,creator_id,title,description,role_label,priority,capacity,deadline,status,scope_path)
     VALUES(org,target,CASE WHEN op='delegate' THEN w.id END,actor,trim(input->>'title'),COALESCE(input->>'description',''),trim(input->>'roleLabel'),input->>'priority',
      (input->>'capacity')::integer,(input->>'deadline')::timestamptz,CASE WHEN op='delegate' THEN 'offered' ELSE 'open' END,ertad.unit_path(org,target)) RETURNING * INTO child;
    IF op='delegate' THEN
     PERFORM ertad.work_need_delegate(actor,w,child,(input->>'needId')::uuid);
     UPDATE ertad.work_items SET version=version+1 WHERE organization_id=org AND id=w.id RETURNING * INTO w;
     INSERT INTO ertad.work_events(organization_id,work_id,version,actor_id,subject_id,action,note,progress,created_at) VALUES(org,w.id,w.version,actor,NULL,'delegate',note,NULL,clock_timestamp());
    END IF;
    w:=child;
   ELSE
    IF w.status IN ('completed','cancelled') AND op NOT IN ('qualification_revoke','provision_return') THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Task finished'; END IF;
    IF op IN ('qualification_define','qualification_claim','qualification_verify','qualification_reject','qualification_revoke','need_create','need_cancel','provision_offer','provision_confirm','provision_withdraw','provision_return','provision_reject') THEN
     event_details:=ertad.work_needs_change(actor,w,op,input);
     IF op LIKE 'qualification_%' THEN note:=''; END IF;
    ELSIF op IN ('coordinator','criteria','criterion_submit','criterion_verify','criterion_return','block','block_update','resolve_block','qualification_define','qualification_claim','qualification_verify','qualification_reject','qualification_revoke','need_create','need_cancel','provision_offer','provision_confirm','provision_withdraw','provision_return','provision_reject') THEN
     event_details:=ertad.work_tracking_change(actor,w,op,input);
    ELSIF op IN ('accept','decline') THEN
     IF w.status<>'offered' OR (op='accept' AND (w.deadline<=clock_timestamp() OR COALESCE((input->>'capacity')::integer,0) NOT BETWEEN 1 AND w.capacity)) THEN
      RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Offer unavailable'; END IF;
     UPDATE ertad.work_items SET status=CASE WHEN op='accept' THEN 'open' ELSE 'cancelled' END,
      coordinator_id=CASE WHEN op='accept' THEN actor ELSE coordinator_id END,
      capacity=CASE WHEN op='accept' THEN (input->>'capacity')::integer ELSE capacity END WHERE organization_id=org AND id=w.id;
     IF op='accept' THEN UPDATE ertad.work_needs SET quantity=(input->>'capacity')::integer WHERE organization_id=org AND work_id=w.id AND source_need_id IS NOT NULL; END IF;
    ELSIF op IN ('cancel','complete') THEN
     IF op='complete' THEN PERFORM ertad.work_need_gate(w,'complete'); END IF;
     IF EXISTS(SELECT 1 FROM ertad.work_items WHERE organization_id=org AND parent_id=w.id AND status IN ('offered','open')) THEN
      RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Finish children first'; END IF;
     IF op='complete' AND (EXISTS(SELECT 1 FROM ertad.work_blockers WHERE organization_id=org AND work_id=w.id AND resolved_at IS NULL) OR EXISTS(SELECT 1 FROM ertad.work_criteria WHERE organization_id=org AND work_id=w.id AND status<>'verified')) THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Resolve blockers and verify criteria first'; END IF;
     IF op='complete' AND (w.status<>'open' OR EXISTS(SELECT 1 FROM ertad.work_assignments WHERE organization_id=org AND work_id=w.id AND status IN ('assigned','in_progress','submitted'))
      OR NOT (EXISTS(SELECT 1 FROM ertad.work_assignments WHERE organization_id=org AND work_id=w.id AND status='verified')
        OR EXISTS(SELECT 1 FROM ertad.work_items WHERE organization_id=org AND parent_id=w.id AND status='completed')
        OR EXISTS(SELECT 1 FROM ertad.work_criteria WHERE organization_id=org AND work_id=w.id AND status='verified'))) THEN
      RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Verified completion required'; END IF;
     -- Cancellation cannot release capacity already consumed by verified work.
     IF op='cancel' AND (EXISTS(SELECT 1 FROM ertad.work_criteria WHERE organization_id=org AND work_id=w.id AND status='verified') OR EXISTS(SELECT 1 FROM ertad.work_assignments WHERE organization_id=org AND work_id=w.id AND status='verified')
       OR EXISTS(SELECT 1 FROM ertad.work_items WHERE organization_id=org AND parent_id=w.id AND status='completed')) THEN
      RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Complete verified work instead'; END IF;
     UPDATE ertad.work_items SET status=CASE WHEN op='cancel' THEN 'cancelled' ELSE 'completed' END WHERE organization_id=org AND id=w.id;
     UPDATE ertad.work_assignments SET status='withdrawn' WHERE organization_id=org AND work_id=w.id AND status IN ('applied','reserved','assigned','in_progress','submitted');
    ELSE
     IF w.status<>'open' OR (op IN ('apply','reserve','assign') AND w.deadline<=clock_timestamp()) THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Task unavailable'; END IF;
     subject:=CASE WHEN op IN ('apply','withdraw','start','progress','submit') THEN actor ELSE (input->>'memberId')::uuid END;
     SELECT * INTO a FROM ertad.work_assignments WHERE organization_id=org AND work_id=w.id AND user_id=subject;
     IF op='apply' THEN
      IF EXISTS(SELECT 1 FROM ertad.work_needs n WHERE n.organization_id=org AND n.work_id=w.id AND n.kind='people' AND NOT n.cancelled) AND NOT EXISTS(SELECT 1 FROM ertad.work_needs n WHERE n.organization_id=org AND n.work_id=w.id AND n.kind='people' AND NOT n.cancelled AND n.id=(input->>'needId')::uuid) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Choose an available role'; END IF;
      IF input->>'needId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ertad.work_needs n WHERE n.organization_id=org AND n.work_id=w.id AND n.kind='people' AND NOT n.cancelled AND n.id=(input->>'needId')::uuid) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid role'; END IF;
      IF FOUND THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Already applied'; END IF;
      INSERT INTO ertad.work_assignments(organization_id,work_id,user_id,status,need_id) VALUES(org,w.id,actor,'applied',(input->>'needId')::uuid);
     ELSE
      IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Application required'; END IF;
      next_status:=CASE
       WHEN op='reserve' AND a.status='applied' THEN 'reserved'
       WHEN op='assign' AND a.status IN ('applied','reserved') THEN 'assigned'
       WHEN op='reject' AND a.status IN ('applied','reserved') THEN 'rejected'
       WHEN op='withdraw' AND a.status IN ('applied','reserved','assigned','in_progress','submitted') THEN 'withdrawn'
       WHEN op='start' AND a.status='assigned' THEN 'in_progress'
       WHEN op='progress' AND a.status='in_progress' THEN 'in_progress'
       WHEN op='submit' AND a.status='in_progress' THEN 'submitted'
       WHEN op='return' AND a.status='submitted' THEN 'in_progress'
       WHEN op='verify' AND a.status='submitted' AND actor<>subject THEN 'verified'
       WHEN op='no_show' AND a.status IN ('assigned','in_progress') THEN 'no_show' END;
      IF next_status IS NULL OR (op='assign' AND ertad.work_used(w)>=w.capacity) THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Transition unavailable'; END IF;
      IF op='start' THEN PERFORM ertad.work_need_gate(w,'start'); END IF;
      IF op='assign' AND a.need_id IS NOT NULL AND EXISTS(SELECT 1 FROM ertad.work_needs n WHERE n.organization_id=org AND n.id=a.need_id AND ertad.work_need_allocated(n)>=n.quantity) THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Role capacity reached'; END IF;
      IF op='progress' AND (COALESCE((input->>'progress')::integer,-1) NOT BETWEEN 0 AND 100 OR length(note)<3) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Progress and note required'; END IF;
      UPDATE ertad.work_assignments SET status=next_status,progress=CASE WHEN op IN ('submit','verify') THEN 100 WHEN op='progress' THEN (input->>'progress')::integer ELSE progress END
       WHERE organization_id=org AND work_id=w.id AND user_id=subject;
      IF op='verify' THEN
       INSERT INTO ertad.activity_entries(organization_id,user_id,unit_id,assignment_id,kind,verifier_id,value) VALUES(org,subject,w.unit_id,a.id,'task_completed',actor,1);
      END IF;
     END IF;
    END IF;
    UPDATE ertad.work_items SET version=version+1 WHERE organization_id=org AND id=w.id RETURNING * INTO w;
   END IF;
   INSERT INTO ertad.work_events(organization_id,work_id,version,actor_id,subject_id,action,note,progress,created_at,details) VALUES(org,w.id,w.version,actor,subject,op,note,CASE WHEN op='progress' THEN (input->>'progress')::integer END,clock_timestamp(),event_details);
   -- Persist IDs only. Every later projection rechecks the recipient's current scope.
   INSERT INTO ertad.work_notifications(organization_id,work_id,version,recipient_id)
    SELECT org,w.id,w.version,u.id FROM ertad.member_users u WHERE u.id<>actor AND u.status='active' AND ertad.work_visible(u.id,w)
    AND (u.id=w.creator_id OR u.id=subject OR ertad.review_has_scope(u.id,org,w.unit_id,'workitem.create') OR ertad.review_has_scope(u.id,org,w.unit_id,'workitem.verify')
     OR (subject IS NULL AND EXISTS(SELECT 1 FROM ertad.work_assignments a WHERE a.organization_id=org AND a.work_id=w.id AND a.user_id=u.id)));
   result:=jsonb_build_object('id',w.id,'version',w.version); changed:=true;
   INSERT INTO ertad.work_commands VALUES(org,actor,(input->>'key')::uuid,w.id,op,input-'key',result);
  END IF;
 END IF;
 RETURN jsonb_build_object('data',result,'audit',jsonb_build_object('actorId',actor,'organizationId',org,'operation',op,'workId',w.id,'changed',changed));
END $$;

CREATE OR REPLACE FUNCTION ertad.work_finish(sid uuid,token text,op text,org uuid,input jsonb,changed boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid; target uuid; w ertad.work_items;
BEGIN
 actor:=ertad.review_identity(sid,token,op<>'ack');
 target:=ertad.work_authorize(actor,org,op,input);
 IF op='delegate' AND (NOT ertad.review_has_scope(actor,org,(input->>'unitId')::uuid,'workitem.create') OR
   NOT ertad.review_has_scope(actor,org,(input->>'unitId')::uuid,'workitem.read')) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Access denied'; END IF;
 IF changed AND op IN ('block','block_update') THEN
  SELECT * INTO w FROM ertad.work_items WHERE organization_id=org AND id=(input->>'id')::uuid;
  IF NOT ertad.work_manager(COALESCE((input->>'memberId')::uuid,w.coordinator_id),w) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Blocker owner no longer eligible'; END IF;
  IF (input->>'nextReviewAt')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Review deadline passed'; END IF;
 END IF;
 IF changed AND op='qualification_verify' AND (input->>'validUntil')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Qualification validity expired'; END IF;
 IF changed AND op IN ('create','delegate','accept','apply','assign','reserve') THEN
  IF op IN ('create','delegate') THEN
   IF (input->>'deadline')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Deadline passed'; END IF;
  ELSE
   SELECT * INTO w FROM ertad.work_items WHERE organization_id=org AND id=(input->>'id')::uuid;
   IF w.deadline<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Deadline passed'; END IF;
  END IF;
 END IF;
 IF changed AND op='need_create' THEN
  SELECT * INTO w FROM ertad.work_items WHERE organization_id=org AND id=(input->>'id')::uuid;
  IF NOT ertad.work_manager((input->>'memberId')::uuid,w) OR (input->>'deadline')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Need owner or deadline no longer eligible'; END IF;
 END IF;
 IF changed AND op='provision_offer' AND EXISTS(SELECT 1 FROM ertad.work_needs WHERE organization_id=org AND id=(input->>'needId')::uuid AND deadline<=clock_timestamp()) THEN RAISE EXCEPTION USING ERRCODE='P0409',MESSAGE='Provision deadline passed'; END IF;
END $$;
