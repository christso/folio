import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {root,fixture,authenticate,mcpConnection,http,browser,evaluate,openEditor,rendered,typeAtEnd,typeAfterLine,until,sleep,recording,verifyReadbacks,httpTrace,mcpTrace} from './harness.mjs';
const kind=process.argv[2];assert(['apiUndo','restUndo','twoEdits'].includes(kind));
const page=fixture.pages[kind],session='folio-retirement-'+kind;
const client=await mcpConnection();const state=await authenticate();await openEditor(session,page,state);
const video=await recording(session,kind);const caption=video.caption;
const marker='Browser note: keep this sentence.';
try{
 caption('MAINTAINED FORK CONTROL | '+kind+'\nOrdinary browser typing and native revision-guarded API/MCP. No injected failure.');await sleep(2000);
 if(kind==='twoEdits')typeAfterLine(session,'Middle: original.',marker);else typeAtEnd(session,marker);
 const read=await until(async()=>{const r=await client.call('read_page',{id:page.id});return r.markdown.includes(marker)?r:false},'browser sentence received');assert.equal(typeof read.bodyRevision,'string');
 let proposed;
 if(kind==='twoEdits'){assert(read.markdown.indexOf('First: old.')<read.markdown.indexOf(marker));assert(read.markdown.indexOf(marker)<read.markdown.indexOf('Last: old.'));proposed=read.markdown.replace('First: old.','First: new.').replace('Last: old.','Last: new.');}
 else proposed=read.markdown.replace('Status: draft.','Status: reviewed.');
 caption(kind==='twoEdits'?'Browser sentence is BETWEEN two unchanged target words.\nFork agent uses TWO exact ranges, guarded by its read revision.':'Browser sentence confirmed by MCP read.\nAgent changes only Status using the freshly read baseRevision.');await sleep(2000);
 let accepted;
 if(kind==='restUndo'){const r=await http('PUT','/api/pages/'+page.id,{markdown:proposed,baseRevision:read.bodyRevision},{agent:true});assert.equal(r.status,200);accepted=r.body;}
 else if(kind==='twoEdits' && process.env.FOLIO_TEST_EXACT_RANGES==='1'){const first=read.markdown.indexOf('First: old.')+7,last=read.markdown.indexOf('Last: old.')+6;const edits=[{from:first,to:first+3,expectedText:'old',text:'new'},{from:last,to:last+3,expectedText:'old',text:'new'}];accepted=await client.call('update_page',{id:page.id,expectedRevision:read.revision,edits});}
 else accepted=await client.call('update_page',{id:page.id,markdown:proposed,baseRevision:read.bodyRevision});
 const target=kind==='twoEdits'?'Last: new.':'Status: reviewed.';
 await until(()=>rendered(session).includes(target),'agent change visible');
 const beforeUndo=await client.call('read_page',{id:page.id});assert.equal(beforeUndo.markdown,proposed);
 assert(evaluate(session,'Boolean(document.activeElement?.closest(".cm-content"))'),'Editor focused before real Undo');
 caption('Both browser and agent changes are visible.\nPress Ctrl+Z in the editor to undo the browser sentence.');await sleep(2200);
 browser(session,'press','Control+z');await sleep(650);
 const visibleAfter=rendered(session);const localSentenceRemoved=!visibleAfter.includes(marker);
 const afterUndo=await until(async()=>{const r=await client.call('read_page',{id:page.id});return r.markdown.includes(marker)===!localSentenceRemoved?r:false},'Undo readback agrees with browser');assert(afterUndo.markdown.includes(target));
 caption(localSentenceRemoved?'PASS: Undo removes only the browser sentence; the agent change remains.':'LIMITATION: Undo does NOT remove the browser sentence between the two agent edits.');
 browser(session,'screenshot',video.out+'/undo.png');await sleep(3000);
 browser(session,'press','Control+y');await until(()=>rendered(session).includes(marker),'Redo sentence visible');
 const checks=kind==='twoEdits'?['First: new.','Last: new.',marker]:['Status: reviewed.',marker];
 const verified=await verifyReadbacks(client,page,session,checks);
 let staleCheck=null;
 if(kind==='apiUndo'){
  const prior=await client.call('read_page',{id:page.id});const newer='Second browser note: protect this edit.';typeAtEnd(session,newer);
  await until(async()=>{const r=await client.call('read_page',{id:page.id});return r.markdown.includes(newer)},'newer sentence received');
  const stale=await http('PUT','/api/pages/'+page.id,{markdown:prior.markdown.replace('Status: reviewed.','Status: approved.'),baseRevision:prior.bodyRevision},{agent:true});
  assert.equal(stale.status,409);assert.equal(stale.body.code??stale.body.error,'revision_conflict');
  const fresh=await client.call('read_page',{id:page.id});assert(fresh.markdown.includes(newer));
  const success=await http('PUT','/api/pages/'+page.id,{markdown:fresh.markdown.replace('Status: reviewed.','Status: approved.'),baseRevision:fresh.bodyRevision},{agent:true});assert.equal(success.status,200);
  staleCheck={staleRestStatus:409,newerBrowserSentenceRetained:true,explicitRereadAndReconciliationSucceeded:true};
  caption('PASS: a later stale REST write returns 409 and retains the newer browser edit.\nExplicit reread/reconciliation with a fresh revision succeeds.');
  await verifyReadbacks(client,page,session,['Status: approved.',marker,newer]);
 }else caption('Reload, REST, HTTP MCP and current Markdown file agree.\n'+(localSentenceRemoved?'Ordinary single-passage API editing preserves useful Undo.':'Two separated edits still span the unchanged middle: PR14 does not provide exact ranges.'));
 browser(session,'screenshot',video.out+'/result.png');await sleep(3500);
 video.finish({case:kind,status:localSentenceRemoved?'PASS':'LIMITATION',scope:'Maintained fork control: exact-range update for twoEdits; native baseRevision for other cases. No backend manipulation.',browserSentence:marker,bodyBeforeApi:read.markdown,bodyAfterApi:beforeUndo.markdown,bodyAfterUndo:afterUndo.markdown,undoRemovedOwnSentence:localSentenceRemoved,agentChangeRetained:true,redoRetainsSentence:true,...verified,staleCheck,httpTrace,mcpTrace});
 console.log(kind+': '+(localSentenceRemoved?'PASS':'LIMITATION (two-edit Undo)'));
}catch(error){writeFileSync(root+'/'+kind+'-failure.private.txt',String(error.stack));throw error;}
finally{await client.close();browser(session,'close');}
