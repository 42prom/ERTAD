import {loadEnvFile} from 'node:process';
import {existsSync,readFileSync,writeFileSync,mkdirSync,unlinkSync} from 'node:fs';
import pg from 'pg';

loadEnvFile('.env');
if (process.env.NODE_ENV && process.env.NODE_ENV!=='development') throw new Error('Local development only');
process.env.NODE_ENV='development';
const port=Number(process.env.ERTAD_POSTGRES_PORT??15432);
if (!Number.isInteger(port)||port<1024||port>65535||!process.env.POSTGRES_PASSWORD||!process.env.APP_DB_PASSWORD||!process.env.API_KEY_ENCRYPTION_SECRET) throw new Error('Initialize local infrastructure/admin first');
process.env.DATABASE_URL=`postgresql://ertad_app:${encodeURIComponent(process.env.APP_DB_PASSWORD)}@127.0.0.1:${port}/ertad`;
const {seedWebDemo}=await import('./web-demo-fixture');
const {enableDemoChannels}=await import('./web-demo-channels');
const {enableDemoHierarchy}=await import('./web-demo-hierarchy');
const {enableDemoPositions}=await import('./web-demo-positions');
const {enableDemoInvitations}=await import('./web-demo-invitations');
const {enableDemoUnitChanges}=await import('./web-demo-unit-changes');
const {enableDemoWork}=await import('./web-demo-work');
const {enableDemoMembers}=await import('./web-demo-members');
const {enableDemoWorkNeeds}=await import('./web-demo-work-needs');
const {enableDemoCollective}=await import('./web-demo-collective');
const {enableDemoContribution}=await import('./web-demo-contribution');
const {enableDemoDecisions}=await import('./web-demo-decisions');
const {demoSchema,demoFile}=await import('../backend/src/localDemo');
const {close}=await import('../backend/src/db/client');
const client=new pg.Client({host:'127.0.0.1',port,database:'ertad',user:'ertad_owner',password:process.env.POSTGRES_PASSWORD,options:'-c search_path=ertad,public'});
const guide='.local/WEB_DEMO_ACCOUNTS.md';
let madeFile=false,madeGuide=false,committed=false;
await client.connect();
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(42420007)');
  if (existsSync(demoFile)) {
    const access=demoSchema.parse(JSON.parse(readFileSync(demoFile,'utf8')));
    for (const a of access.accounts) {
      const found=await client.query('SELECT 1 FROM admin_users a JOIN member_users u ON u.web_account_id=a.id WHERE a.id=$1 AND a.email=$2 AND u.id=$3',[a.id,a.email,a.memberId]);
      if (!found.rowCount) throw new Error('Existing demo fixture does not match database; refusing replacement');
    }
    if(process.argv.includes('--invitations')){await enableDemoInvitations(client,access);await client.query('COMMIT');committed=true;}
    else if(process.argv.includes('--members')){await enableDemoMembers(client,access);await client.query('COMMIT');committed=true;}
    else if(process.argv.includes('--channels')){await enableDemoChannels(client,access);await client.query('COMMIT');committed=true;}
    else if(process.argv.includes('--operations')){await enableDemoWork(client,access);await enableDemoWorkNeeds(client,access);await enableDemoCollective(client,access);await enableDemoContribution(client,access);await client.query('COMMIT');committed=true;}
    else if(process.argv.includes('--contribution')){await enableDemoContribution(client,access);await client.query('COMMIT');committed=true;}
    else if(process.argv.includes('--collective')){await enableDemoCollective(client,access);await client.query('COMMIT');committed=true;}
    else if(process.argv.includes('--needs')){await enableDemoWorkNeeds(client,access);await client.query('COMMIT');committed=true;}
    else if(process.argv.includes('--work')){await enableDemoWork(client,access);await client.query('COMMIT');committed=true;}
    else if(process.argv.includes('--decisions')){await enableDemoDecisions(client,access);await client.query('COMMIT');committed=true;}
    else if(process.argv.includes('--positions')){await enableDemoPositions(client,access);await client.query('COMMIT');committed=true;}
    else if(process.argv.includes('--unit-changes')){await enableDemoUnitChanges(client,access);await client.query('COMMIT');committed=true;}
    else if(process.argv.includes('--hierarchy')){await enableDemoHierarchy(client,access);await client.query('COMMIT');committed=true;}
    else await client.query('ROLLBACK');
    console.log('Existing six demo accounts preserved; no passwords, requests or grants reset.');
  } else {
    const access=await seedWebDemo(client);
    if(process.argv.includes('--invitations'))await enableDemoInvitations(client,access);
    else if(process.argv.includes('--members'))await enableDemoMembers(client,access);
    else if(process.argv.includes('--channels'))await enableDemoChannels(client,access);
    else if(process.argv.includes('--operations')){await enableDemoWork(client,access);await enableDemoWorkNeeds(client,access);await enableDemoCollective(client,access);await enableDemoContribution(client,access);}
    else if(process.argv.includes('--contribution'))await enableDemoContribution(client,access);
    else if(process.argv.includes('--collective'))await enableDemoCollective(client,access);
    else if(process.argv.includes('--needs'))await enableDemoWorkNeeds(client,access);
    else if(process.argv.includes('--work'))await enableDemoWork(client,access);
    else if(process.argv.includes('--decisions'))await enableDemoDecisions(client,access);
    else if(process.argv.includes('--positions'))await enableDemoPositions(client,access);
    else if(process.argv.includes('--unit-changes'))await enableDemoUnitChanges(client,access);
    else if(process.argv.includes('--hierarchy'))await enableDemoHierarchy(client,access);
    mkdirSync('.local',{recursive:true});
    writeFileSync(demoFile,JSON.stringify(access,null,2)+'\n',{flag:'wx',mode:0o600});madeFile=true;
    writeFileSync(guide,['# ERTAD — ვებ-დემო', '', 'http://localhost:15173/login — სწრაფი შესვლის ექვსი ღილაკი.', '',
      'მხოლოდ ლოკალური სატესტო ანგარიშები. საბჭო ხედავს ორივე რეგიონს; რეგიონი მხოლოდ საკუთარ ერთეულებს.',
      'მოთხოვნების დასადასტურებლად შედი საბჭოს მეორე ან შესაბამისი რეგიონის მეორე ანგარიშით. პირველი რეგიონული ანგარიში მოთხოვნის ბენეფიციარია და ვერ დაადასტურებს.', '',
      ...access.accounts.flatMap(a=>[`## ${a.label}`,`ელფოსტა: ${a.email}`,`პაროლი: ${a.password}`,`სატესტო წევრის ID: ${a.memberId}`,'']),
      'ფაილი შეიცავს საიდუმლოებებს: არ გამოაქვეყნო. ხელახლა გაშვება არსებულ მონაცემებს არ ანულებს.'].join('\n'),{flag:'wx',mode:0o600});madeGuide=true;
    await client.query('COMMIT');committed=true;
    console.log('Created six synthetic accounts, two regions and two pending reviews. Credentials: .local/WEB_DEMO_ACCOUNTS.md');
  }
  const lines=readFileSync('.env','utf8').trimEnd().split(/\r?\n/);
  for (const key of ['ERTAD_LOCAL_ADMIN','ERTAD_WEB_DEMO']) {const index=lines.findIndex(l=>l.startsWith(key+'='));if(index<0)lines.push(key+'=true');else lines[index]=key+'=true';}
  writeFileSync('.env',lines.join('\n')+'\n');
} catch(error) {
  if(!committed){await client.query('ROLLBACK');if(madeFile)unlinkSync(demoFile);if(madeGuide)unlinkSync(guide);}throw error;
} finally {await client.end();await close();}
