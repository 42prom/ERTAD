-- Infrastructure only. Domain tables require the reviewed P2/P3 model.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA ertad FROM PUBLIC;
GRANT USAGE ON SCHEMA ertad TO ertad_app;
GRANT SELECT ON ertad.schema_migrations TO ertad_app;
-- Grant table/sequence privileges explicitly in each owning module's migration.
