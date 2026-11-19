import { randomBytes, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import type { DemoAccess } from '../backend/src/localDemo';
import { hashAdminPassword } from '../backend/src/services/adminPassword';
import { generateMfaSecret } from '../backend/src/services/adminMfa';
import { encryptSensitiveValue } from '../backend/src/services/secretEncryption';
import { SecurityService } from '../backend/src/services/security';

/** Caller owns the transaction. Offline development/test fixtures only. */
export async function seedWebDemo(client: Client): Promise<DemoAccess> {
  if (!['development', 'test'].includes(process.env.NODE_ENV ?? '')) throw new Error('Demo fixtures are development/test only');
  await client.query('SELECT pg_advisory_xact_lock(42420007)');
  const existing = await client.query("SELECT 1 FROM admin_users WHERE email LIKE '%@demo.ertad.local'");
  if (existing.rowCount) throw new Error('Demo accounts already exist; refusing to overwrite credentials or authority');
  const org = randomUUID(), root = randomUUID(), regions = [randomUUID(), randomUUID()], groups = [randomUUID(), randomUUID()];
  await client.query('INSERT INTO organizations(id,name) VALUES($1,$2)', [org, 'ERTAD · ვებ-დემო']);
  for (const [id, parent, name] of [[root,null,'საბჭო'],[regions[0],root,'რეგიონი A'],[regions[1],root,'რეგიონი B'],[groups[0],regions[0],'ჯგუფი A'],[groups[1],regions[1],'ჯგუფი B']]) {
    await client.query("INSERT INTO units(organization_id,id,parent_id,name,kind) VALUES($1,$2,$3,$4,'authority')", [org,id,parent,name]);
  }
  const bundle = randomUUID(), observer = randomUUID();
  for (const [id, permissions] of [[bundle,['unit.read','membership.propose','membership.approve']], [observer,['unit.read']]] as const) {
    await client.query('INSERT INTO permission_bundles(organization_id,id,version) VALUES($1,$2,1)', [org,id]);
    for (const permission of permissions) await client.query("INSERT INTO permission_grants VALUES($1,$2,1,$3,'subtree')", [org,id,permission]);
    await client.query("UPDATE permission_bundles SET status='approved' WHERE organization_id=$1 AND id=$2", [org,id]);
  }
  const positions: string[] = [], reviewPositions: string[] = [];
  for (const [index, unit] of [root,...regions,...groups].entries()) {
    const id = randomUUID();
    await client.query('INSERT INTO positions(organization_id,id,unit_id,name,bundle_id,bundle_version) VALUES($1,$2,$3,$4,$5,1)',
      [org,id,unit,index===0?'საბჭოს ადმინისტრატორი':index<3?'რეგიონის ადმინისტრატორი':'ჯგუფის მიმომხილველი',index<3?bundle:observer]);
    if (index<3) positions.push(id); else reviewPositions.push(id);
  }
  const access: DemoAccess = {version:1,organizationId:org,accounts:[]};
  for (let i=0;i<6;i++) {
    const tier = Math.floor(i/2), number=i%2+1;
    const label=tier===0?`საბჭოს ადმინისტრატორი ${number}`:`რეგიონი ${tier===1?'A':'B'} · ადმინისტრატორი ${number}`;
    const email=`${tier===0?'council':tier===1?'region.a':'region.b'}.${number}@demo.ertad.local`;
    const account={id:randomUUID(),memberId:randomUUID(),unitId:[root,...regions][tier],email,password:randomBytes(24).toString('base64url'),label,region:tier===0?'ორივე რეგიონი':`რეგიონი ${tier===1?'A':'B'}`};
    await client.query('INSERT INTO admin_users(id,email,password_hash,role,full_name,mfa_secret_encrypted) VALUES($1,$2,$3,$4,$5,$6)',
      [account.id,email,await hashAdminPassword(account.password),tier===0?'superadmin':'admin',label,encryptSensitiveValue(generateMfaSecret())]);
    await client.query('INSERT INTO member_users(id,web_account_id) VALUES($1,$2)', [account.memberId,account.id]);
    await client.query("INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until) VALUES($1,$2,$3,$4,1,now()-interval '1 minute',now()+interval '90 days')",
      [org,account.memberId,account.unitId,positions[tier]]);
    access.accounts.push(account);
  }
  for (let i=0;i<2;i++) {
    await client.query(`INSERT INTO membership_reviews(organization_id,requester_id,target_id,unit_id,position_id,bundle_id,bundle_version,reason,valid_until,expires_at,request_key)
      VALUES($1,$2,$3,$4,$5,$6,1,$7,now()+interval '30 days',now()+interval '6 days',$8)`,
      [org,access.accounts[0].memberId,access.accounts[2+i*2].memberId,groups[i],reviewPositions[i],observer,
        `სატესტო მოთხოვნა: რეგიონი ${i===0?'A':'B'} — ჯგუფის მიმომხილველად დანიშვნა`,randomUUID()]);
  }
  await SecurityService.logAuditEventInTransaction(client,'LOCAL_WEB_DEMO_SEEDED',{organizationId:org,accountCount:6,synthetic:true});
  return access;
}
