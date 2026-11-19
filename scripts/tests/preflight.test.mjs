import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {plannedPorts,ownsRunningPort,assertPortAvailable} from '../preflight.mjs';
const port = published => ({host_ip:'127.0.0.1',published});
const config={name:'ertad',services:{postgres:{ports:[port('15432')]},api:{profiles:['apps'],ports:[port('13000')]},web:{profiles:['apps'],ports:[port('15173')]}}};
test('data-only startup ignores app-profile ports while full-stack startup validates them',()=>{
  assert.deepEqual(plannedPorts(config),[{service:'postgres',port:15432}]);
  assert.equal(plannedPorts(config,true).length,3);
  const invalid=structuredClone(config);invalid.services.web.ports[0].published='15432';
  assert.equal(plannedPorts(invalid).length,1);assert.throws(()=>plannedPorts(invalid,true),/duplicate/);
  invalid.services.postgres.ports[0].host_ip='0.0.0.0';assert.throws(()=>plannedPorts(invalid),/loopback/);
});
test('foreign stopped containers reserve ports; only the matching running ERTAD service can reuse its binding',()=>{
  const container={Name:'/fixture',Config:{Labels:{'com.docker.compose.project':'ertad','com.docker.compose.service':'postgres'}},HostConfig:{PortBindings:{'5432/tcp':[{HostPort:'15432'}]}},State:{Running:true}};
  assert.equal(ownsRunningPort([container],'postgres',15432),true);
  assert.throws(()=>ownsRunningPort([container],'redis',15432),/reserved/);
  container.State.Running=false;assert.equal(ownsRunningPort([container],'postgres',15432),false);
  container.Config.Labels['com.docker.compose.project']='other';assert.throws(()=>ownsRunningPort([container],'postgres',15432),/reserved/);
});
test('occupied host port fails without killing its listener',async()=>{
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const bound=server.address().port;
  try{await assert.rejects(assertPortAvailable(bound,'API'),/already in use/);assert.equal(server.listening,true);}
  finally{await new Promise(resolve=>server.close(resolve));}
  await assertPortAvailable(bound,'API');
});
