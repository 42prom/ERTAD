import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDevControl,requestDevStop} from '../dev-control.mjs';

test('stop targets only this checkout and confirms completed cleanup; repeated stop is harmless',async()=>{
  const roots=await Promise.all([mkdtemp(path.join(tmpdir(),'ertad-control-a-')),mkdtemp(path.join(tmpdir(),'ertad-control-b-'))]);
  let first,second,stopped=0;
  try {
    for(const root of roots)await mkdir(path.join(root,'.local'));
    assert.equal(await requestDevStop(roots[0]),false);
    first=await openDevControl(roots[0],async()=>{first.close();await new Promise(r=>setTimeout(r,20));stopped++;});
    second=await openDevControl(roots[1],()=>{throw new Error('Unrelated checkout must not stop');});
    assert.equal(await requestDevStop(roots[0]),true);
    assert.equal(stopped,1);assert.equal(second.listening,true);
    assert.equal(await requestDevStop(roots[0]),false);
  }finally{
    for(const server of [first,second])if(server?.listening)await new Promise(resolve=>server.close(resolve));
    for(const root of roots){await rmdir(path.join(root,'.local'));await rmdir(root);}
  }
});
