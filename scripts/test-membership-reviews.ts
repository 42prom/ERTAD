import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import pg from 'pg';
import request from 'supertest';
import pino from 'pino';
import bcrypt from 'bcrypt';

loadEnvFile('.env');
const database = `ertad_review_test_${randomBytes(8).toString('hex')}`;
const port = Number(process.env.ERTAD_POSTGRES_PORT ?? 15432);
assert.ok(port >= 1024 && port <= 65535 && process.env.POSTGRES_PASSWORD && process.env.APP_DB_PASSWORD);
const config = { host: '127.0.0.1', port, user: 'ertad_owner', password: process.env.POSTGRES_PASSWORD };
const control = new pg.Client({ ...config, database: 'ertad' });
const owner = new pg.Client({ ...config, database, options: '-c search_path=ertad,public' });
process.env.NODE_ENV = 'test';
process.env.API_KEY_ENCRYPTION_SECRET = randomBytes(32).toString('base64url');
process.env.DATABASE_URL = `postgresql://ertad_app:${encodeURIComponent(process.env.APP_DB_PASSWORD!)}@127.0.0.1:${port}/${database}`;
let created = false, connected = false, close: (() => Promise<void>) | undefined, checks = 0;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const org = randomUUID(), root = randomUUID(), bundle = randomUUID(), basePosition = randomUUID();
const people = Array.from({ length: 4 }, () => {
  const token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
  return { account: randomUUID(), member: randomUUID(), sessionId: randomUUID(), sessionTokenHash: hash(token), token, csrf };
});
const [proposer, reviewer, target, stranger] = people;
async function check(name: string, fn: () => Promise<void>) { await fn(); checks++; console.log(`PASS ${name}`); }
await control.connect();
try {
  await control.query(`CREATE DATABASE ${database}`); created = true;
  execFileSync(process.execPath, ['--import','tsx','backend/src/migrate.ts'], { encoding: 'utf8', env: { ...process.env,
    MIGRATION_DATABASE_URL: `postgresql://ertad_owner:${encodeURIComponent(process.env.POSTGRES_PASSWORD!)}@127.0.0.1:${port}/${database}` } });
  await owner.connect(); connected = true;
  const db = await import('../backend/src/db/client.ts'); close = db.close;
  const { encryptSensitiveValue } = await import('../backend/src/services/secretEncryption.ts');
  const password = randomBytes(24).toString('base64url');
  const passwordHash = await bcrypt.hash(password, 10);
  const { reviewCommand } = await import('../backend/src/modules/governance/reviews.ts');
  const command = (who: typeof proposer, op: Parameters<typeof reviewCommand>[1], input: object = {}) => reviewCommand(who,op,{ organizationId: org,...input });
  const denied = (promise: Promise<unknown>, status = 403) => assert.rejects(promise,(e: any) => e.statusCode===status);
  for (const [i,p] of people.entries()) {
    await owner.query(`INSERT INTO admin_users(id,email,password_hash,role,mfa_secret_encrypted) VALUES($1,$2,$3,'superadmin','v2:synthetic')`,[p.account,`review${i}@example.invalid`,passwordHash]);
    await owner.query(`INSERT INTO admin_sessions(id,admin_user_id,token_hash,csrf_token_hash,csrf_token_encrypted,idle_expires_at,absolute_expires_at,step_up_expires_at)
      VALUES($1,$2,$3,$4,$5,now()+interval '1 hour',now()+interval '2 hours',now()+interval '20 minutes')`,[p.sessionId,p.account,p.sessionTokenHash,hash(p.csrf),encryptSensitiveValue(p.csrf)]);
    await owner.query('INSERT INTO member_users(id,web_account_id) VALUES($1,$2)',[p.member,p.account]);
  }
  await owner.query("INSERT INTO organizations(id,name) VALUES($1,'Synthetic review organization')",[org]);
  await owner.query("INSERT INTO units(organization_id,id,name,kind) VALUES($1,$2,'Synthetic root','authority')",[org,root]);
  await owner.query('INSERT INTO permission_bundles(organization_id,id,version) VALUES($1,$2,1)',[org,bundle]);
  for (const permission of ['membership.propose','membership.approve','unit.read']) await owner.query("INSERT INTO permission_grants VALUES($1,$2,1,$3,'subtree')",[org,bundle,permission]);
  await owner.query("UPDATE permission_bundles SET status='approved' WHERE organization_id=$1",[org]);
  await owner.query("INSERT INTO positions(organization_id,id,unit_id,name,bundle_id,bundle_version) VALUES($1,$2,$3,'Synthetic existing position',$4,1)",[org,basePosition,root,bundle]);
  for (const p of [proposer,reviewer,target]) await owner.query(`INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from)
    VALUES($1,$2,$3,$4,1,now()-interval '1 minute')`,[org,p.member,root,basePosition]);
  const fresh = async () => {
    const positionId = randomUUID();
    await owner.query("INSERT INTO positions(organization_id,id,unit_id,name,bundle_id,bundle_version) VALUES($1,$2,$3,'Synthetic proposed position',$4,1)",[org,positionId,root,bundle]);
    return { key: randomUUID(),positionId,targetId: target.member,reason: 'Synthetic operational reason',
      expiresAt: new Date(Date.now()+3600_000).toISOString(), validUntil: new Date(Date.now()+86400_000).toISOString() };
  };
  const decision = (id: string) => ({ id,key: randomUUID(),decision: 'approved',reason: 'Synthetic independent decision' });
  const count = async (table: string) => Number((await owner.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
  await check('contexts and pending counts derive from persisted scope, never role names',async () => {
    assert.equal((await reviewCommand(proposer,'contexts',{})).length,1);
    assert.deepEqual(await reviewCommand(stranger,'contexts',{}),[]);
    assert.equal((await command(stranger,'list')).total,0);
  });
  const payload = await fresh(); let review: { id: string; status: string };
  await check('proposal is immutable, retry-safe, and grants no authority',async () => {
    const before = await count('memberships'); review = await command(proposer,'propose',payload);
    assert.equal(review.status,'pending'); assert.equal(await count('memberships'),before);
    assert.deepEqual(await command(proposer,'propose',payload),review);
    await denied(command(proposer,'propose',{...payload,reason:'Different operational reason'}),409);
    assert.equal((await command(reviewer,'list')).total,1);
    assert.equal((await command(proposer,'list')).total,0);
    assert.equal((await command(proposer,'list',{view:'mine'})).total,1);
    await denied(command(stranger,'detail',{id:review.id}));
  });
  await check('self grant, own request, beneficiary approval, outsider and cross-tenant access denied',async () => {
    await denied(command(proposer,'propose',{...payload,key:randomUUID(),targetId:proposer.member}));
    await denied(command(proposer,'decide',decision(review.id)));
    await denied(command(target,'decide',decision(review.id)));
    await denied(command(stranger,'decide',decision(review.id)));
    await denied(command(reviewer,'detail',{id:review.id,organizationId:randomUUID()}));
  });
  await check('step-up, revoked sessions and inactive members are freshly checked',async () => {
    await owner.query('UPDATE admin_sessions SET step_up_expires_at=NULL WHERE id=$1',[reviewer.sessionId]);
    await denied(command(reviewer,'decide',decision(review.id)),428);
    await owner.query("UPDATE admin_sessions SET step_up_expires_at=now()+interval '20 minutes',revoked_at=now() WHERE id=$1",[reviewer.sessionId]);
    await denied(command(reviewer,'detail',{id:review.id}));
    await owner.query('UPDATE admin_sessions SET revoked_at=NULL WHERE id=$1',[reviewer.sessionId]);
    await owner.query("UPDATE member_users SET status='suspended' WHERE id=$1",[reviewer.member]);
    await denied(command(reviewer,'detail',{id:review.id}));
    await owner.query("UPDATE member_users SET status='active' WHERE id=$1",[reviewer.member]);
  });
  await check('requester revocation prevents a formerly valid grant',async () => {
    await owner.query("UPDATE memberships SET status='suspended' WHERE user_id=$1",[proposer.member]);
    await denied(command(reviewer,'decide',decision(review.id)),409);
    await owner.query("UPDATE memberships SET status='active' WHERE user_id=$1",[proposer.member]);
  });
  await check('audit failure rolls back decision, membership and notifications',async () => {
    const before = await count('memberships');
    await owner.query(`CREATE FUNCTION reject_review_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_type='MEMBERSHIP_REVIEW' THEN RAISE EXCEPTION 'Synthetic audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_review_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_review_audit()`);
    await assert.rejects(command(reviewer,'decide',decision(review.id)));
    assert.equal(await count('memberships'),before); assert.equal(await count('review_notifications'),0);
    assert.equal((await owner.query('SELECT status FROM membership_reviews WHERE id=$1',[review.id])).rows[0].status,'pending');
    await owner.query('DROP TRIGGER reject_review_audit ON audit_log; DROP FUNCTION reject_review_audit()');
  });
  await check('concurrent identical decisions apply once; conflicting stale tab cannot overwrite',async () => {
    const args=decision(review.id), before=await count('memberships');
    const [a,b]=await Promise.all([command(reviewer,'decide',args),command(reviewer,'decide',args)]);
    assert.deepEqual(a,b); assert.equal(a.status,'approved'); assert.equal(await count('memberships'),before+1);
    assert.equal(await count('review_notifications'),2);
    await denied(command(reviewer,'decide',{...args,decision:'rejected'}),409);
  });
  await check('notifications are recipient scoped and read is idempotent, separate from decision',async () => {
    assert.equal((await command(proposer,'notifications')).items.length,1);
    assert.equal((await command(stranger,'notifications')).items.length,0);
    await denied(command(reviewer,'read',{id:review.id}));
    await command(proposer,'read',{id:review.id}); await command(proposer,'read',{id:review.id});
    assert.ok((await command(proposer,'notifications')).items[0].read_at);
    await owner.query("UPDATE memberships SET status='suspended' WHERE user_id=$1",[proposer.member]);
    assert.equal((await command(proposer,'notifications')).items.length,0);
    await owner.query("UPDATE memberships SET status='active' WHERE user_id=$1",[proposer.member]);
  });
  await check('independent rejection leaves memberships unchanged',async () => {
    const r=await command(proposer,'propose',await fresh()),before=await count('memberships');
    const args={...decision(r.id),decision:'rejected'};
    assert.equal((await command(reviewer,'decide',args)).status,'rejected');
    assert.deepEqual(await command(reviewer,'decide',args),{id:r.id,status:'rejected'});
    assert.equal(await count('memberships'),before);
  });
  await check('position retirement and bundle version drift block approval',async () => {
    const data=await fresh(),r=await command(proposer,'propose',data);
    await owner.query("UPDATE positions SET status='retired' WHERE id=$1",[data.positionId]);
    await denied(command(reviewer,'decide',decision(r.id)),409);
    await owner.query("INSERT INTO permission_bundles(organization_id,id,version,status) VALUES($1,$2,2,'approved')",[org,bundle]);
    await owner.query("UPDATE positions SET status='active',bundle_version=2 WHERE id=$1",[data.positionId]);
    await denied(command(reviewer,'decide',decision(r.id)),409);
  });
  await check('expired request disappears from pending and cannot execute',async () => {
    const data=await fresh(); data.expiresAt=new Date(Date.now()+400).toISOString();
    const r=await command(proposer,'propose',data);
    await new Promise(resolve=>setTimeout(resolve,450));
    await denied(command(reviewer,'decide',decision(r.id)),409);
    assert.ok((await command(reviewer,'list',{view:'history',status:'expired'})).items.some((x:any)=>x.id===r.id));
  });
  await check('runtime cannot write grants, reviews, notifications or call private policy helpers',async () => {
    for(const sql of ["UPDATE membership_reviews SET status='approved'",'DELETE FROM membership_reviews','TRUNCATE membership_reviews',
      'DELETE FROM review_notifications',"INSERT INTO memberships(organization_id) VALUES(NULL)",
      "SELECT ertad.review_has_scope(NULL,NULL,NULL,'membership.approve')"]) {
      await assert.rejects(db.pool.query(sql),(e:any)=>e.code==='42501');
    }
    await assert.rejects(owner.query("UPDATE membership_reviews SET reason='Tampered historical reason'"),(e:any)=>e.code==='23514');
  });
  await check('bounded filters and minimal audit contain no private reason or credential',async () => {
    await denied(command(reviewer,'list',{page:1001}),400);
    await denied(command(proposer,'propose',{...payload,role:'superadmin'}),400);
    const events=await owner.query("SELECT payload FROM audit_log WHERE event_type='MEMBERSHIP_REVIEW'");
    for(const row of events.rows) for(const secret of [payload.reason,reviewer.token,reviewer.sessionTokenHash]) assert.ok(!row.payload.includes(secret));
  });
  await check('HTTP enforces cookie session, Origin, CSRF and scoped authorization',async () => {
    const {createLocalAdminRouter}=await import('../backend/src/localAdmin.ts');
    const {createApp}=await import('../backend/src/app.ts');
    const origin='http://localhost:15173';
    const app=createApp({postgres:async()=>{},redis:async()=>{},storage:async()=>{}},pino({enabled:false}),origin,createLocalAdminRouter(origin));
    await request(app).get('/api/v1/admin/reviews/contexts').expect(401);
    await request(app).get('/api/v1/admin/reviews/contexts').set('Authorization','Bearer synthetic.mobile.token').expect(401);
    const cookie=`ertad_admin_session=${reviewer.token}`;
    await request(app).get('/api/v1/admin/reviews/contexts').set('Cookie',cookie).expect(200);
    await request(app).post('/api/v1/admin/reviews/decision').set('Cookie',cookie).send({}).expect(403);
    await request(app).post('/api/v1/admin/reviews/decision').set('Origin',origin).set('Cookie',cookie).send({}).expect(403);
    await request(app).post('/api/v1/admin/reviews/decision').set('Origin',origin).set('Cookie',cookie).set('X-Admin-CSRF',reviewer.csrf)
      .send({organizationId:org,...decision(review.id)}).expect(409);
  });
  await check('audit failure rolls back a newly proposed request as well',async()=>{
    const data=await fresh(),before=await count('membership_reviews');
    await owner.query(`CREATE FUNCTION reject_new_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic audit failure'; END $$;
      CREATE TRIGGER reject_new_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_new_audit()`);
    await assert.rejects(command(proposer,'propose',data));
    assert.equal(await count('membership_reviews'),before);
    await owner.query('DROP TRIGGER reject_new_audit ON audit_log; DROP FUNCTION reject_new_audit()');
  });
  await check('step-up expiry during audit persistence rolls back all grant writes',async()=>{
    const data=await fresh(),r=await command(proposer,'propose',data),before=await count('memberships');
    await owner.query(`CREATE FUNCTION slow_review_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.2); RETURN NEW; END $$;
      CREATE TRIGGER slow_review_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION slow_review_audit()`);
    await owner.query("UPDATE admin_sessions SET step_up_expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",[reviewer.sessionId]);
    await denied(command(reviewer,'decide',decision(r.id)),428);
    assert.equal(await count('memberships'),before);
    assert.equal((await owner.query('SELECT status FROM membership_reviews WHERE id=$1',[r.id])).rows[0].status,'pending');
    await owner.query('DROP TRIGGER slow_review_audit ON audit_log; DROP FUNCTION slow_review_audit()');
    await owner.query("UPDATE admin_sessions SET step_up_expires_at=now()+interval '20 minutes' WHERE id=$1",[reviewer.sessionId]);
  });
  await check('one of two independent conflicting reviewers wins, with one membership and notification pair',async()=>{
    await owner.query(`INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from)
      VALUES($1,$2,$3,$4,1,now()-interval '1 minute')`,[org,stranger.member,root,basePosition]);
    const data=await fresh(),r=await command(proposer,'propose',data);
    const outcomes=await Promise.allSettled([command(reviewer,'decide',decision(r.id)),command(stranger,'decide',{...decision(r.id),decision:'rejected'})]);
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
    assert.equal((outcomes.find(x=>x.status==='rejected') as PromiseRejectedResult).reason.statusCode,409);
    assert.equal(Number((await owner.query('SELECT count(*) FROM review_notifications WHERE review_id=$1',[r.id])).rows[0].count),2);
    await owner.query("UPDATE memberships SET status='ended' WHERE user_id=$1",[stranger.member]);
  });
  await check('unit-only authority does not cover descendants or professional siblings',async()=>{
    const local=randomUUID(),professional=randomUUID(),limited=randomUUID(),position=randomUUID();
    await owner.query("INSERT INTO units(organization_id,id,parent_id,name,kind) VALUES($1,$2,$3,'Synthetic child','authority'),($1,$4,$3,'Synthetic professional','professional')",[org,local,root,professional]);
    await owner.query('INSERT INTO permission_bundles(organization_id,id,version) VALUES($1,$2,1)',[org,limited]);
    await owner.query("INSERT INTO permission_grants VALUES($1,$2,1,'membership.approve','unit')",[org,limited]);
    await owner.query("UPDATE permission_bundles SET status='approved' WHERE id=$1",[limited]);
    await owner.query("INSERT INTO positions(organization_id,id,unit_id,name,bundle_id,bundle_version) VALUES($1,$2,$3,'Limited reviewer',$4,1)",[org,position,local,limited]);
    await owner.query(`INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from)
      VALUES($1,$2,$3,$4,1,now()-interval '1 minute')`,[org,stranger.member,local,position]);
    for(const [unit,expected] of [[local,true],[root,false],[professional,false]] as const) {
      const actual=(await owner.query("SELECT ertad.review_has_scope($1,$2,$3,'membership.approve') allowed",[stranger.member,org,unit])).rows[0].allowed;
      assert.equal(actual,expected);
    }
    const child=randomUUID();await owner.query("INSERT INTO units(organization_id,id,parent_id,name,kind) VALUES($1,$2,$3,'Nested child','authority')",[org,child,local]);
    assert.equal((await owner.query("SELECT ertad.review_has_scope($1,$2,$3,'membership.approve') allowed",[stranger.member,org,child])).rows[0].allowed,false);
    await owner.query("UPDATE units SET status='archived' WHERE organization_id=$1 AND id=$2",[org,local]);
    assert.equal((await owner.query("SELECT ertad.review_has_scope($1,$2,$3,'membership.approve') allowed",[stranger.member,org,local])).rows[0].allowed,false);
  });
  if (process.argv.includes('--browser')) {
    const { runReviewBrowser } = await import('./review-browser.ts');
    await runReviewBrowser({ people, password, org, fresh, owner });
  }
  console.log(`PASS ${checks} membership review scenarios`);
} finally {
  if(close) await close(); if(connected) await owner.end();
  if(created) await control.query(`DROP DATABASE ${database} WITH (FORCE)`);
  await control.end();
}
