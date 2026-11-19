import {createServer,createConnection} from 'node:net';
import {createHash} from 'node:crypto';
import {mkdir,chmod} from 'node:fs/promises';
import path from 'node:path';

function address(root) {
  const key=createHash('sha256').update(process.platform==='win32'?root.toLowerCase():root).digest('hex').slice(0,20);
  return process.platform==='win32' ? `\\\\.\\pipe\\ertad-dev-${key}` : path.join(root,'.local','dev-control.sock');
}

// Local IPC only: no TCP listener and no PID lookup that could stop another project.
export async function openDevControl(root,stop) {
  if(process.platform!=='win32')await mkdir(path.join(root,'.local'),{recursive:true});
  const server=createServer(socket=>{
    socket.setEncoding('utf8');socket.setTimeout(2000,()=>socket.destroy());
    socket.on('error',()=>{});
    let command='';
    socket.on('data',chunk=>{
      command+=chunk;
      if(command.length>32){socket.destroy();return;}
      if(!command.includes('\n'))return;
      socket.removeAllListeners('data');
      if(command!=='stop\n'){socket.end('invalid\n');return;}
      socket.setTimeout(0);
      Promise.resolve().then(stop).then(()=>socket.end('stopped\n'),()=>socket.end('failed\n'));
    });
  });
  await new Promise((resolve,reject)=>{
    server.once('error',()=>reject(new Error('ERTAD dev control is unavailable. If another copy is running, use npm run dev:stop first.')));
    server.listen(address(root),resolve);
  });
  if(process.platform!=='win32')await chmod(address(root),0o600);
  return server;
}

export function requestDevStop(root) {
  return new Promise((resolve,reject)=>{
    const socket=createConnection(address(root));let response='';
    socket.setEncoding('utf8');socket.setTimeout(15000,()=>socket.destroy(new Error('ERTAD shutdown timed out. Check the dev terminal.')));
    socket.on('connect',()=>socket.write('stop\n'));
    socket.on('data',chunk=>{response+=chunk;});
    socket.on('end',()=>response==='stopped\n'?resolve(true):reject(new Error('ERTAD did not confirm shutdown.')));
    socket.on('error',error=>['ENOENT','ECONNREFUSED'].includes(error.code)?resolve(false):reject(error));
  });
}
