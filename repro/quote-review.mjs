import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {root,fixture,authenticate,mcpConnection,http,httpTrace,mcpTrace,browser,evaluate,openEditor,rendered,typeAtEnd,until,sleep,recording,verifyReadbacks,runtime} from './harness.mjs';
const kind=process.argv[2];assert(['quote','review'].includes(kind));
const page=fixture.pages[kind==='quote'?'quoteCompatibility':'review'],session='folio-retirement-'+kind;
const client=await mcpConnection(),state=await authenticate();await openEditor(session,page,state);
const video=await recording(session,kind),caption=video.caption;
try{
 caption('UPSTREAM + PR14 | '+kind+'\nNative browser, REST and HTTP MCP actions only. No storage failure injection.');await sleep(1800);
 if(kind==='quote'){
  const before=await client.call('read_page',{id:page.id});const marker='Browser note: added after agent prepared its quotation.';typeAtEnd(session,marker);
  await until(async()=>{const r=await client.call('read_page',{id:page.id});return r.markdown.includes(marker)},'new browser note received');
  const fresh=(await http('GET','/api/pages/'+page.id,undefined,{agent:true})).body;assert.notEqual(fresh.bodyRevision,before.bodyRevision);const old='Status: draft.';assert.equal(fresh.markdown.split(old).length-1,1);
  const put=await http('PUT','/api/pages/'+page.id,{markdown:fresh.markdown.replace(old,'Status: quote-client-reviewed.'),baseRevision:fresh.bodyRevision},{agent:true});assert.equal(put.status,200);
  caption('PASS: client rereads, confirms the quotation is unique, then uses native baseRevision.\nThe requested passage changes while the newer browser sentence remains.');await sleep(2500);
  const verified=await verifyReadbacks(client,page,session,[marker,'Status: quote-client-reviewed.']);
  const putsBefore=httpTrace.filter(x=>x.method==='PUT').length;
  const current=(await http('GET','/api/pages/'+page.id,undefined,{agent:true})).body;const missing=current.markdown.split(old).length-1===0,ambiguous=current.markdown.split('original.').length-1>1;assert(missing&&ambiguous);
  const putsAfter=httpTrace.filter(x=>x.method==='PUT').length;assert.equal(putsBefore,putsAfter);
  caption('PASS: absent or ambiguous quotations are refused by client preflight, without another PUT.\nThis replaces one-passage functionality, not atomic location fences or save receipts.');browser(session,'screenshot',video.out+'/result.png');await sleep(3000);
  video.finish({case:'quoteCompatibility',status:'PASS',initialRevisionDifferedFromFresh:true,newerBrowserNoteRetained:true,nativeGuardedQuoteReplacementSucceeded:true,missingAndAmbiguousQuotesStoppedBeforePut:true,notEquivalentToAtomicLocationOrPersistenceReceipts:true,...verified,httpTrace,mcpTrace});
 }else{
  const marker='Browser note: retain this during review.';typeAtEnd(session,marker);
  const read=await until(async()=>{const r=await client.call('read_page',{id:page.id});return r.markdown.includes(marker)?r:false},'review baseline with browser note');
  const mode=await http('PATCH','/api/spaces/'+fixture.space+'/agent-settings',{agentWriteMode:'review'});assert.equal(mode.status,200);
  const proposed=await client.call('update_page',{id:page.id,markdown:read.markdown.replace('Status: draft.','Status: reviewer-approved.'),baseRevision:read.bodyRevision});assert.equal(proposed.status,'proposed');assert(proposed.proposalId);
  const pending=await client.call('read_page',{id:page.id});assert(pending.markdown.includes('Status: draft.'));
  caption('MCP submitted ONE proposal in review mode. Current page is unchanged.\nOpen the real review dialog and click Accept.');
  browser(session,'open',runtime.base+'/s/'+fixture.space+'/p/'+page.id+'?review='+proposed.proposalId);
  await until(()=>evaluate(session,'Array.from(document.querySelectorAll("button")).some(x=>x.textContent.trim()==="Accept"&&!x.disabled)'),'real Accept button');await sleep(2200);
  evaluate(session,'Array.from(document.querySelectorAll("button")).find(x=>x.textContent.trim()==="Accept"&&!x.disabled).click();true');
  const accepted=await until(async()=>{const r=await http('GET','/api/proposals/'+proposed.proposalId);return r.body.status==='accepted'?r.body:false},'proposal accepted');
  browser(session,'press','Escape');
  browser(session,'open',runtime.base+'/s/'+fixture.space+'/p/'+page.id);
  const verified=await verifyReadbacks(client,page,session,[marker,'Status: reviewer-approved.']);
  caption('PASS: real browser acceptance changes Status and retains the browser sentence.\nReload, REST, HTTP MCP and current file agree.');browser(session,'screenshot',video.out+'/result.png');await sleep(3000);
  video.finish({case:'review',status:'PASS',proposalId:proposed.proposalId,pendingPageUnchanged:true,realBrowserAccept:true,decisionStatus:accepted.status,...verified,httpTrace,mcpTrace});
 }
 console.log(kind+': PASS');
}catch(error){writeFileSync(root+'/'+kind+'-failure.private.txt',String(error.stack));throw error;}
finally{if(kind==='review')await http('PATCH','/api/spaces/'+fixture.space+'/agent-settings',{agentWriteMode:'direct'});await client.close();browser(session,'close');}
