-- Minimum persisted authority for reviewed unit reads. No bootstrap or seed grants.
-- Identity is opaque; legal identity, demographics and biometric data do not belong here.
CREATE TABLE ertad.member_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  web_account_id uuid UNIQUE REFERENCES ertad.admin_users(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ertad.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  authority_revision bigint NOT NULL DEFAULT 0 CHECK (authority_revision >= 0)
);
CREATE TABLE ertad.units (
  organization_id uuid NOT NULL REFERENCES ertad.organizations(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  parent_id uuid,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  kind text NOT NULL CHECK (kind IN ('authority', 'professional', 'project')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, parent_id) REFERENCES ertad.units(organization_id, id),
  CHECK (parent_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX units_one_root ON ertad.units (organization_id) WHERE parent_id IS NULL;
CREATE INDEX units_parent ON ertad.units (organization_id, parent_id);
CREATE TABLE ertad.permission_bundles (
  organization_id uuid NOT NULL REFERENCES ertad.organizations(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'revoked')),
  PRIMARY KEY (organization_id, id, version)
);
CREATE TABLE ertad.permission_grants (
  organization_id uuid NOT NULL,
  bundle_id uuid NOT NULL,
  bundle_version integer NOT NULL,
  permission text NOT NULL CHECK (permission IN ('unit.read', 'workitem.create', 'workitem.verify')),
  scope text NOT NULL CHECK (scope IN ('unit', 'subtree')),
  PRIMARY KEY (organization_id, bundle_id, bundle_version, permission, scope),
  FOREIGN KEY (organization_id, bundle_id, bundle_version)
    REFERENCES ertad.permission_bundles(organization_id, id, version)
);
CREATE TABLE ertad.positions (
  organization_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  unit_id uuid NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  bundle_id uuid NOT NULL,
  bundle_version integer NOT NULL,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, unit_id, id),
  FOREIGN KEY (organization_id, unit_id) REFERENCES ertad.units(organization_id, id),
  FOREIGN KEY (organization_id, bundle_id, bundle_version)
    REFERENCES ertad.permission_bundles(organization_id, id, version)
);
CREATE TABLE ertad.memberships (
  organization_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES ertad.member_users(id),
  unit_id uuid NOT NULL,
  position_id uuid NOT NULL,
  bundle_version integer NOT NULL CHECK (bundle_version > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'ended')),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, unit_id, position_id)
    REFERENCES ertad.positions(organization_id, unit_id, id),
  CHECK (isfinite(valid_from)),
  CHECK (valid_until IS NULL OR (isfinite(valid_until) AND valid_until > valid_from))
);
CREATE INDEX memberships_user ON ertad.memberships (organization_id, user_id, unit_id);

-- Every authority change updates the same organization row before validation.
-- Shared readers hold that row until audit + commit. Updating (not merely locking)
-- also makes stale REPEATABLE READ writers fail with a serialization error.
CREATE FUNCTION ertad.serialize_authority_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE org uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.organization_id IS DISTINCT FROM OLD.organization_id
      OR to_jsonb(NEW)->'id' IS DISTINCT FROM to_jsonb(OLD)->'id') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Authority identity is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN org := OLD.organization_id; ELSE org := NEW.organization_id; END IF;
  UPDATE ertad.organizations SET authority_revision = authority_revision + 1 WHERE id = org;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Organization required'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER a_serialize BEFORE INSERT OR UPDATE OR DELETE ON ertad.units
  FOR EACH ROW EXECUTE FUNCTION ertad.serialize_authority_change();
CREATE TRIGGER a_serialize BEFORE INSERT OR UPDATE OR DELETE ON ertad.permission_bundles
  FOR EACH ROW EXECUTE FUNCTION ertad.serialize_authority_change();
CREATE TRIGGER a_serialize BEFORE INSERT OR UPDATE OR DELETE ON ertad.permission_grants
  FOR EACH ROW EXECUTE FUNCTION ertad.serialize_authority_change();
CREATE TRIGGER a_serialize BEFORE INSERT OR UPDATE OR DELETE ON ertad.positions
  FOR EACH ROW EXECUTE FUNCTION ertad.serialize_authority_change();
CREATE TRIGGER a_serialize BEFORE INSERT OR UPDATE OR DELETE ON ertad.memberships
  FOR EACH ROW EXECUTE FUNCTION ertad.serialize_authority_change();

CREATE FUNCTION ertad.validate_unit_ancestry() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL AND EXISTS (
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_id FROM ertad.units WHERE organization_id = NEW.organization_id AND id = NEW.parent_id
      UNION
      SELECT u.id, u.parent_id FROM ertad.units u JOIN ancestors a ON u.id = a.parent_id
        WHERE u.organization_id = NEW.organization_id
    ) SELECT 1 FROM ancestors WHERE id = NEW.id
  ) THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Unit hierarchy must be acyclic'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER b_validate_ancestry BEFORE INSERT OR UPDATE ON ertad.units
  FOR EACH ROW EXECUTE FUNCTION ertad.validate_unit_ancestry();

CREATE FUNCTION ertad.freeze_permission_bundle() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Published bundle is immutable'; END IF;
    RETURN OLD;
  END IF;
  IF NEW.version <> OLD.version OR (OLD.status = 'revoked' AND NEW.status <> 'revoked')
    OR (OLD.status = 'approved' AND NEW.status NOT IN ('approved', 'revoked')) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Published bundle is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER b_freeze_bundle BEFORE UPDATE OR DELETE ON ertad.permission_bundles
  FOR EACH ROW EXECUTE FUNCTION ertad.freeze_permission_bundle();

CREATE FUNCTION ertad.freeze_permission_grants() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM ertad.permission_bundles WHERE organization_id = OLD.organization_id
      AND id = OLD.bundle_id AND version = OLD.bundle_version AND status = 'draft'
  ) THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Published grants are immutable'; END IF;
  IF TG_OP <> 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM ertad.permission_bundles WHERE organization_id = NEW.organization_id
      AND id = NEW.bundle_id AND version = NEW.bundle_version AND status = 'draft'
  ) THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Grants require a draft bundle'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER b_freeze_grants BEFORE INSERT OR UPDATE OR DELETE ON ertad.permission_grants
  FOR EACH ROW EXECUTE FUNCTION ertad.freeze_permission_grants();

-- Runtime gets no authority-write privileges. This narrowly scoped helper only locks
-- existing session/identity/organization rows; it does not grant permission or mutate them.
-- It avoids granting UPDATE on identities solely to allow SELECT ... FOR SHARE.
CREATE FUNCTION ertad.lock_web_authority(session_id uuid, session_hash text, organization_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE account uuid; member uuid;
BEGIN
  SELECT s.admin_user_id INTO account FROM ertad.admin_sessions s
    WHERE s.id = session_id AND s.token_hash = session_hash FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied'; END IF;
  PERFORM 1 FROM ertad.admin_users u WHERE u.id = account FOR SHARE;
  SELECT u.id INTO member FROM ertad.member_users u WHERE u.web_account_id = account FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied'; END IF;
  PERFORM 1 FROM ertad.organizations o WHERE o.id = organization_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied'; END IF;
  RETURN member;
END;
$$;
REVOKE ALL ON FUNCTION ertad.lock_web_authority(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.lock_web_authority(uuid, text, uuid) TO ertad_app;
REVOKE ALL ON FUNCTION ertad.serialize_authority_change(), ertad.validate_unit_ancestry(),
  ertad.freeze_permission_bundle(), ertad.freeze_permission_grants() FROM PUBLIC;
GRANT SELECT ON ertad.member_users, ertad.organizations, ertad.units, ertad.permission_bundles,
  ertad.permission_grants, ertad.positions, ertad.memberships TO ertad_app;
