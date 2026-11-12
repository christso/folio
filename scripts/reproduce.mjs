import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {root,runtime,fixture,authenticate,mcpConnection,http,browser,evaluate,openEditor,rendered,typeAfterLine,until,sleep,recording,verifyReadbacks,httpTrace,mcpTrace} from './harness.mjs';
const page=fixture.pages.twoEdits,session='folio-pr14-two-passages-'+runtime.mode;
const client=await mcpConnection(),state=await authenticate();await openEditor(session,page,state);
const video=await recording(session,'capture');const caption=video.caption;
const marker='Browser note: keep this sentence.';
try{
 caption(runtime.mode.toUpperCase()+' | '+runtime.commit.slice(0,12)+'\nBrowser typing, then ONE normal MCP update changing two passages.');await sleep(2200);
 typeAfterLine(session,'Middle: original.',marker);
 const read=await until(async()=>{const r=await client.call('read_page',{id:page.id});return r.markdown.includes(marker)?r:false},'browser sentence received');assert.equal(typeof read.bodyRevision,'string');
 assert(read.markdown.indexOf('First: old.')<read.markdown.indexOf(marker));assert(read.markdown.indexOf(marker)<read.markdown.indexOf('Last: old.'));
 const proposed=read.markdown.replace('First: old.','First: new.').replace('Last: old.','Last: new.');
 caption('Browser sentence is BETWEEN the target words.\nAgent reads the current body and revision, then changes First and Last.');await sleep(2200);
 const accepted=await client.call('update_page',{id:page.id,markdown:proposed,baseRevision:read.bodyRevision});
 await until(()=>rendered(session).includes('Last: new.'),'agent change visible');
 const beforeUndo=await client.call('read_page',{id:page.id});assert.equal(beforeUndo.markdown,proposed);
 assert(evaluate(session,'Boolean(document.activeElement?.closest(".cm-content"))'),'Editor focused before Undo');
 caption('Both agent changes and the browser sentence are visible.\nPress Ctrl+Z to undo the browser sentence.');await sleep(2500);
 browser(session,'press','Control+z');await sleep(800);
 const localSentenceRemoved=!rendered(session).includes(marker);
 assert.equal(localSentenceRemoved,runtime.mode==='after','Expected baseline failure or patched success');
 const afterUndo=await until(async()=>{const r=await client.call('read_page',{id:page.id});return r.markdown.includes(marker)===!localSentenceRemoved?r:false},'Undo MCP readback agrees');
 const undoRest=await http('GET','/api/pages/'+page.id,undefined,{agent:true});assert.equal(undoRest.status,200);assert.equal(undoRest.body.markdown,afterUndo.markdown);
 assert(afterUndo.markdown.includes('First: new.'));assert(afterUndo.markdown.includes('Last: new.'));
 caption(localSentenceRemoved?'AFTER: Undo removes only the browser sentence.\nBoth agent changes remain; REST and MCP confirm the result.':'BEFORE: Undo leaves the browser sentence in place.\nBoth agent changes remain; REST and MCP confirm the failure.');
 browser(session,'screenshot',video.out+'/undo.png');await sleep(4500);
 caption('Press Ctrl+Y to redo the browser edit.\nThen reload and verify the final body through REST and MCP.');
 browser(session,'press','Control+y');await until(()=>rendered(session).includes(marker),'Redo sentence visible');await sleep(1800);
 const verified=await verifyReadbacks(client,page,session,['First: new.','Last: new.',marker]);
 caption('Reload, REST, MCP and the current Markdown file agree.\n'+(localSentenceRemoved?'PASS: Undo and Redo work across both agent edits.':'REPRODUCED: Undo could not remove the browser sentence.'));
 browser(session,'screenshot',video.out+'/result.png');await sleep(5000);
 video.finish({case:'one-request-two-passages',status:localSentenceRemoved?'PASS':'REPRODUCED',commit:runtime.commit,image:runtime.image,atomicRequest:true,updatePageCalls:mcpTrace.filter(x=>x.name==='update_page').length,bodyBeforeApi:read.markdown,bodyAfterApi:beforeUndo.markdown,bodyAfterUndo:afterUndo.markdown,undoRemovedOwnSentence:localSentenceRemoved,bothAgentChangesRetained:true,redoRetainsSentence:true,undoRestMcpMatch:true,...verified,httpTrace,mcpTrace});
 console.log(runtime.mode+': '+(localSentenceRemoved?'PASS':'REPRODUCED'));
}catch(error){writeFileSync(root+'/capture-failure.private.txt',String(error.stack),{mode:0o600});throw error;}
finally{await client.close();browser(session,'close');}
