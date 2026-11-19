import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {loadEnvFile} from 'node:process';
import pg from 'pg';
import request from 'supertest';
import pino from 'pino';

loadEnvFile('.env');
const database=`ertad_demo_test_${randomBytes(8).toString('hex')}`,port=Number(process.env.ERTAD_POSTGRES_PORT??15432);
const options={host:'127.0.0.1',port,user:'ertad_owner',password:process.env.POSTGRES_PASSWORD};
const control=new pg.Client({...options,database:'ertad'}),owner=new pg.Client({...options,database,options:'-c search_path=ertad,public'});
process.env.NODE_ENV='test';process.env.ERTAD_WEB_DEMO='true';
process.env.API_KEY_ENCRYPTION_SECRET=randomBytes(32).toString('base64url');
process.env.DATABASE_URL=`postgresql://ertad_app:${encodeURIComponent(process.env.APP_DB_PASSWORD!)}@127.0.0.1:${port}/${database}`;
let created=false,connected=false,close:(()=>Promise<void>)|undefined,checks=0;
const origin='http://localhost:15173';
async function check(name:string,fn:()=>Promise<void>){await fn();checks++;console.log(`PASS ${name}`);}
await control.connect();
try {
  await control.query(`CREATE DATABASE ${database}`);created=true;
  execFileSync(process.execPath,['--import','tsx','backend/src/migrate.ts'],{stdio:'pipe',env:{...process.env,MIGRATION_DATABASE_URL:`postgresql://ertad_owner:${encodeURIComponent(process.env.POSTGRES_PASSWORD!)}@127.0.0.1:${port}/${database}`}});
  await owner.connect();connected=true;
  close=(await import('../backend/src/db/client')).close;
  const {seedWebDemo}=await import('./web-demo-fixture');
  await owner.query('BEGIN');const access=await seedWebDemo(owner);await owner.query('COMMIT');
  const {createApp}=await import('../backend/src/app');
  const {createLocalAdminRouter}=await import('../backend/src/localAdmin');
  const {createLocalDemoRouter}=await import('../backend/src/localDemo');
  const {Router}=await import('express');
  const app=createApp({postgres:async()=>{},redis:async()=>{},storage:async()=>{}},pino({level:'silent'}),origin,createLocalAdminRouter(origin,()=>access));
  const base='/api/v1/admin';
  const sessions:{agent:ReturnType<typeof request.agent>;csrf:string}[]=[];
  const reviews=(await owner.query('SELECT id,unit_id,target_id FROM membership_reviews ORDER BY reason')).rows;
  if(process.argv.includes('--browser')) {
    const {runDemoBrowser}=await import('./web-demo-browser');await runDemoBrowser(app,access,owner);checks++;
  } else {
  await check('six synthetic accounts and two regions are seeded without password export',async()=>{
    const r=await request(app).get(base+'/demo/accounts').expect(200);
    assert.equal(r.body.accounts.length,6);assert.equal(r.headers['cache-control'],'no-store');
    for(const a of access.accounts)assert.ok(!JSON.stringify(r.body).includes(a.password));
    assert.equal(reviews.length,2);
    await owner.query('BEGIN');await assert.rejects(seedWebDemo(owner));await owner.query('ROLLBACK');
    assert.equal(Number((await owner.query('SELECT count(*) FROM admin_users')).rows[0].count),6);
  });
  await check('feature disabled, production, foreign Origin/Host and unknown accounts are denied',async()=>{
    await request(app).get(base+'/demo/accounts').set('Host','attacker.invalid').expect(403);
    await request(app).get(base+'/demo/accounts').set('Sec-Fetch-Site','cross-site').expect(403);
    await request(app).post(base+'/demo/login').send({accountId:access.accounts[0].id}).expect(403);
    await request(app).post(base+'/demo/login').set('Origin','https://attacker.invalid').send({accountId:access.accounts[0].id}).expect(403);
    await request(app).post(base+'/demo/login').set('Origin',origin).send({accountId:randomUUID()}).expect(403);
    await request(app).post(base+'/demo/login').set('Origin',origin).send({accountId:access.accounts[0].id,password:'injected'}).expect(400);
    process.env.ERTAD_WEB_DEMO='false';
    const disabled=createApp({postgres:async()=>{},redis:async()=>{},storage:async()=>{}},pino({level:'silent'}),origin,createLocalAdminRouter(origin,()=>access));
    assert.deepEqual((await request(disabled).get(base+'/demo/accounts').expect(200)).body,{enabled:false,accounts:[]});
    await request(disabled).post(base+'/demo/login').set('Origin',origin).send({accountId:access.accounts[0].id}).expect(404);
    process.env.ERTAD_WEB_DEMO='true';process.env.NODE_ENV='production';
    assert.throws(()=>createLocalDemoRouter(origin,Router(),()=>access));process.env.NODE_ENV='test';
  });
  await check('each quick login verifies a real password and creates a cookie/CSRF session',async()=>{
    for(const a of access.accounts){const agent=request.agent(app);const r=await agent.post(base+'/demo/login').set('Origin',origin).send({accountId:a.id}).expect(200);
      assert.equal(r.body.user.id,a.id);assert.ok(r.headers['set-cookie']);assert.ok(r.body.csrfToken);sessions.push({agent,csrf:r.body.csrfToken});}
    const original=access.accounts[0].password;access.accounts[0].password=randomBytes(24).toString('base64url');
    await request(app).post(base+'/demo/login').set('Origin',origin).send({accountId:access.accounts[0].id}).expect(401);access.accounts[0].password=original;
  });
  await check('council sees both regions; each regional pair sees only its own positions and demo members',async()=>{
    for(let i=0;i<6;i++){
      const {agent}=sessions[i],r=await agent.get(base+'/reviews/contexts').expect(200);assert.equal(r.body.length,1);
      const units=new Set(r.body[0].positions.map((p:{unitId:string})=>p.unitId));assert.equal(units.size,i<2?5:2);
      const people=await agent.get(base+'/demo/scenario').expect(200);assert.equal(people.body.accounts.length,i<2?6:2);
      const ownRegion=i<4?0:1;
      if(i>=2){await agent.get(base+'/reviews/detail').query({organizationId:access.organizationId,id:reviews[1-ownRegion].id}).expect(403);}
    }
  });
  await check('step-up requires authenticated demo identity, Origin and CSRF',async()=>{
    await request(app).post(base+'/demo/step-up').set('Origin',origin).send({}).expect(401);
    await sessions[3].agent.post(base+'/demo/step-up').set('Origin',origin).send({}).expect(403);
    await sessions[3].agent.post(base+'/demo/step-up').set('Origin',origin).set('X-Admin-Csrf',sessions[3].csrf).send({}).expect(200);
  });
  const decision={organizationId:access.organizationId,id:reviews[0].id,key:randomUUID(),decision:'approved',reason:'Synthetic independent regional approval'};
  await check('requester and beneficiary cannot approve; regional reviewer can, exactly once',async()=>{
    for(const index of [0,2]){
      const s=sessions[index];await s.agent.post(base+'/demo/step-up').set('Origin',origin).set('X-Admin-Csrf',s.csrf).send({}).expect(200);
      await s.agent.post(base+'/reviews/decision').set('Origin',origin).set('X-Admin-Csrf',s.csrf).send(decision).expect(403);
    }
    const s=sessions[3];
    await s.agent.post(base+'/reviews/decision').set('Origin',origin).set('X-Admin-Csrf',s.csrf).send(decision).expect(200);
    await s.agent.post(base+'/reviews/decision').set('Origin',origin).set('X-Admin-Csrf',s.csrf).send(decision).expect(200);
    assert.equal(Number((await owner.query('SELECT count(*) FROM memberships')).rows[0].count),7);
    assert.equal(Number((await owner.query('SELECT count(*) FROM review_notifications')).rows[0].count),2);
  });
  await check('recipient sees notification; the other region cannot see completed review',async()=>{
    const r=await sessions[2].agent.get(base+'/reviews/notifications').query({organizationId:access.organizationId}).expect(200);assert.equal(r.body.items.length,1);
    await sessions[5].agent.get(base+'/reviews/detail').query({organizationId:access.organizationId,id:reviews[0].id}).expect(403);
  });
  await check('revoked member authority and disabled accounts cannot use quick login',async()=>{
    await owner.query("UPDATE memberships SET status='suspended' WHERE user_id=$1",[access.accounts[4].memberId]);
    await request(app).post(base+'/demo/login').set('Origin',origin).send({accountId:access.accounts[4].id}).expect(403);
    const r=await sessions[4].agent.get(base+'/reviews/contexts').expect(200);assert.deepEqual(r.body,[]);
    await owner.query('UPDATE admin_users SET is_active=false WHERE id=$1',[access.accounts[5].id]);
    await request(app).post(base+'/demo/login').set('Origin',origin).send({accountId:access.accounts[5].id}).expect(401);
  });
  await check('missing fixture fails closed, logout revokes the cookie session',async()=>{
    const broken=createApp({postgres:async()=>{},redis:async()=>{},storage:async()=>{}},pino({level:'silent'}),origin,createLocalAdminRouter(origin,()=>{throw new Error('Synthetic missing fixture');}));
    await request(broken).get(base+'/demo/accounts').expect(500);
    await request(broken).post(base+'/demo/login').set('Origin',origin).send({accountId:access.accounts[0].id}).expect(500);
    await sessions[1].agent.post(base+'/auth/logout').set('Origin',origin).set('X-Admin-Csrf',sessions[1].csrf).send({}).expect(204);
    await sessions[1].agent.get(base+'/reviews/contexts').expect(401);
  });
  }
  console.log(`PASS ${checks} web demo scenarios`);
} finally {
  if(close)await close();if(connected)await owner.end();
  if(created)await control.query(`DROP DATABASE ${database} WITH (FORCE)`);await control.end();
}
