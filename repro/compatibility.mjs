import assert from 'node:assert/strict';
import {writeFileSync,mkdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {root,runtime,fixture,authenticate,http,httpTrace,sha} from './harness.mjs';
const infra=process.env.FOLIO_CLIENT_SOURCE;assert(infra);
const {Folio}=await import(pathToFileURL(infra+'/deploy/rakazo/folio/folio.mjs'));
const {Broker}=await import(pathToFileURL(infra+'/deploy/rakazo/folio/broker.mjs'));
const {Operations}=await import(pathToFileURL(infra+'/deploy/rakazo/folio/operations.mjs'));
await authenticate();
const legacy=new Folio(runtime.base,fixture.auth.token);
const page=fixture.pages.adapter;
const loc={space:fixture.space,path:page.path};
const configuredGrant={id:'synthetic-bot',account:'synthetic-account',spaceId:'synthetic-space',notes:[],read:[loc],write:[{...loc,route:'direct',policySource:'synthetic-owner-request'}]};
const broker=new Broker({folio:legacy,operations:new Operations(root+'/client-journal.private'),grant:()=>configuredGrant});
let oldRead;
try{await broker.read('synthetic-principal',loc);oldRead={accepted:true};}catch(e){oldRead={accepted:false,code:e.code};}
assert.equal(oldRead.code,'unsupported_page');
const quotation=await http('POST','/api/pages/'+page.id+'/replace-text',{oldText:'Status: draft.',newText:'Status: client-reviewed.',expectedLocation:loc},{agent:true});
assert.equal(quotation.status,404);
// A small test client using only the upstream contract. No production adapter changes.
const read=async(location)=>{
 const resolve=await http('GET','/api/resolve?'+new URLSearchParams(location),undefined,{agent:true});assert.equal(resolve.status,200);
 const r=await http('GET','/api/pages/'+resolve.body.id,undefined,{agent:true});assert.equal(r.status,200);
 assert.equal(r.body.space,location.space);assert.equal(r.body.path,location.path);assert.equal(typeof r.body.bodyRevision,'string');return r.body;
};
const initial=await read(loc);assert.equal(initial.markdown.split('Status: draft.').length-1,1);
const update=await http('PUT','/api/pages/'+initial.id,{markdown:initial.markdown.replace('Status: draft.','Status: client-reviewed.'),baseRevision:initial.bodyRevision},{agent:true});assert.equal(update.status,200);
const after=await read(loc);assert(after.markdown.includes('Status: client-reviewed.'));
const nativeResponseFields=Object.keys(update.body).sort();
assert(!Object.hasOwn(update.body,'persistence'));assert(!Object.hasOwn(update.body,'revision'));
const result={case:'clientCompatibility',status:'MIGRATION_REQUIRED',clientSourceCommit:'bffe3fb3d02859842e1bda74342e741a2dc87f8d',existingBrokerRead:oldRead,existingReplaceTextEndpointStatus:quotation.status,nativeGuardedReadReplaceReadSucceeded:true,nativeResponseFields,missingForkReceiptFields:['revision','changed','persistence','publication'].filter(k=>!Object.hasOwn(update.body,k)),locationNote:'This test client checks current location on read. It does not recreate the fork atomic location fence or claim equivalent persistence receipts.',scope:'Read-only import of the profile-owned infra clone; synthetic grants and private test journal only. No production broker or infra source modified.',httpTrace,baseline:runtime.baseline,fixedCommit:runtime.fixedCommit,noFaultInjection:true};
writeFileSync(root+'/client-compatibility.json',JSON.stringify(result,null,2)+'\n');console.log('Client compatibility: existing broker rejects missing revision; fork replace-text is 404. Native baseRevision client successfully edits. Migration and receipt-contract decision required.');
