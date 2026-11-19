import express from 'express';
import request from 'supertest';
import { createProviderControl, lookupIPHub, protectProviderInput, providerProposalSchema, type ProviderPolicy, type ProviderLookup } from '../src/modules/security/providerPolicy';
import { decryptSensitiveValue, encryptSensitiveValue } from '../src/services/secretEncryption';

const credential = 'synthetic-provider-key';
const defaults: ProviderPolicy = {version:0,provider:'none',mode:'off',blockSuspicious:false,hasCredential:false,credentialCipher:null};
function enforced():ProviderPolicy{return {...defaults,version:1,provider:'iphub',mode:'enforce',hasCredential:true,credentialCipher:encryptSensitiveValue(credential)};}
function fixture(read:()=>Promise<unknown>,lookup:ProviderLookup,source='cloudflare'){
 const app=express();
 const control=createProviderControl(read,lookup);
 app.use((q,s,n)=>{s.locals.networkSource=source;s.locals.networkAddress='192.0.2.1';s.locals.networkAddressKey='synthetic-key';n();});
 app.get('/',control.guard,(_q,s)=>s.sendStatus(200));
 return app;
}
test('off and local recovery do not disclose addresses to the provider',async()=>{
 const lookup=jest.fn<ReturnType<ProviderLookup>,Parameters<ProviderLookup>>();
 await request(fixture(async()=>defaults,lookup)).get('/').expect(200);
 await request(fixture(async()=>{throw Error('offline');},lookup,'local')).get('/').expect(200);
 expect(lookup).not.toHaveBeenCalled();
});
test.each([0,1,2] as const)('IPHub verdict %s obeys reviewed risk policy and cache',async(value)=>{
 let policy=enforced();const lookup=jest.fn(async()=>value);
 const app=fixture(async()=>policy,lookup);
 await request(app).get('/').expect(value===1?403:200);
 await request(app).get('/').expect(value===1?403:200);
 expect(lookup).toHaveBeenCalledTimes(1);
 expect(lookup).toHaveBeenCalledWith('192.0.2.1',credential);
 policy={...policy,version:2,blockSuspicious:true};
 await request(app).get('/').expect(value===0?200:403);
 expect(lookup).toHaveBeenCalledTimes(2);
});
test('failure, malformed policy and untrusted identity deny without exposing provider details',async()=>{
 const policy=enforced();
 for(const read of [async()=>policy,async()=>({...policy,mode:'invalid'}),async()=>{throw Error('database secret');}]){
   const result=await request(fixture(read,async()=>{throw Error('private provider key');})).get('/').expect(503);
   expect(result.body).toEqual({error:{code:'PROVIDER_UNAVAILABLE'}});
 }
 const lookup=jest.fn(async()=>0 as const);
 await request(fixture(async()=>policy,lookup,'unverified')).get('/').expect(503);
 expect(lookup).not.toHaveBeenCalled();
});
test('in-flight verdict cannot authorize after a policy version changes',async()=>{
 let policy=enforced();const app=fixture(async()=>policy,async()=>{policy={...policy,version:2};return 0;});
 await request(app).get('/').expect(503);
});
test('credentials are randomized authenticated ciphertext with stable request fingerprints',()=>{
 const input=providerProposalSchema.parse({requestId:'11111111-1111-4111-8111-111111111111',expectedVersion:0,provider:'iphub',mode:'off',blockSuspicious:false,apiKey:credential,reason:'provider_change'});
 const first=protectProviderInput(input),second=protectProviderInput(input);
 expect(first.credentialCipher).not.toBe(second.credentialCipher);
 expect(first.credentialDigest).toBe(second.credentialDigest);
 expect(decryptSensitiveValue(first.credentialCipher!)).toBe(credential);
 expect(JSON.stringify(first)).not.toContain(credential);
 expect(first).not.toHaveProperty('apiKey');
});
test('browser cannot submit URLs, cipher, runtime flags or unsupported providers',()=>{
 const input={requestId:'11111111-1111-4111-8111-111111111111',expectedVersion:0,provider:'iphub',mode:'off',blockSuspicious:false,reason:'provider_change'};
 for(const patch of [{url:'http://127.0.0.1'},{credentialCipher:'x'},{runtimeReady:true},{provider:'mock'},{apiKey:'secret\r\nheader'}])
 expect(providerProposalSchema.safeParse({...input,...patch}).success).toBe(false);
});
test('adapter uses a fixed HTTPS origin and refuses redirects, wrong IPs and oversized responses',async()=>{
 const original=global.fetch;
 const fetcher=jest.fn<ReturnType<typeof fetch>,Parameters<typeof fetch>>();global.fetch=fetcher;
 try {
   fetcher.mockResolvedValue(new Response(JSON.stringify({ip:'192.0.2.1',block:1})));
   expect(await lookupIPHub('192.0.2.1',credential)).toBe(1);
   expect(fetcher).toHaveBeenCalledWith('https://v2.api.iphub.info/ip/192.0.2.1',expect.objectContaining({redirect:'error',headers:expect.objectContaining({'X-Key':credential})}));
   for(const body of [JSON.stringify({ip:'192.0.2.2',block:0}),JSON.stringify({ip:'192.0.2.1',block:9}),'x'.repeat(8193)]){
     fetcher.mockResolvedValue(new Response(body));
     await expect(lookupIPHub('192.0.2.1',credential)).rejects.toThrow();
   }
   fetcher.mockResolvedValue(new Response('',{status:429}));
   await expect(lookupIPHub('192.0.2.1',credential)).rejects.toThrow();
 } finally {global.fetch=original;}
});
