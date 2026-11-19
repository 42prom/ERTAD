// Global Jest Setup for Backend
// This runs before any test file is executed.

process.env.NODE_ENV = 'test';


process.env.PN_HASH_SECRET ??= 'test-pn-hash-secret';
process.env.JWT_SECRET ??= 'test-jwt-secret';
// Never inherit development credentials or default to ERTAD/local shared databases.
// An isolated integration harness must supply dedicated disposable targets before these tests run.
process.env.DATABASE_URL = process.env.ERTAD_TEST_DATABASE_URL || 'postgresql://invalid:invalid@127.0.0.1:1/ertad_test_unconfigured';
process.env.REDIS_URL = process.env.ERTAD_TEST_REDIS_URL || 'redis://127.0.0.1:1/15';
