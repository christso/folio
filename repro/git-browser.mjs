import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {root,fixture,authenticate,mcpConnection,http,browser,evaluate,openEditor,rendered,typeAtEnd,until,sleep,recording,verifyReadbacks,httpTrace,mcpTrace,git,gitEdit,sync,remoteFile} from './harness.mjs';
const kind=process.argv[2];assert(['gitUndo','gitUndoFinalNewline','threeWriters','gitConflict'].includes(kind));
const page=fixture.pages[kind],session='folio-retirement-'+kind;
const client=await mcpConnection(),state=await authenticate();await openEditor(session,page,state);
const video=await recording(session,kind),caption=video.caption;
const marker='Browser note: preserve my sentence.';
try{
 caption('UPSTREAM + PR14 | '+kind+'\nReal browser, real HTTP MCP and separate Git clone/HTTP remote. No injected failures.');await sleep(2000);
 let beforeSync;
 if(kind==='gitConflict'){
  // Real Git agent commits a different value from the common published baseline.
  gitEdit(page,'Status: draft.','Status: agent-reviewed.','Git agent edits same status');
  const n=evaluate(session,'(()=>{const el=Array.from(document.querySelectorAll(".cm-content > .cm-line")).find(x=>x.innerText.includes("Status: draft."));return el?Array.from(el.parentElement.children).indexOf(el)+1:null})()');assert(n);
  browser(session,'click','.cm-content > .cm-line:nth-child('+n+')');browser(session,'press','Home');browser(session,'press','Shift+End');browser(session,'keyboard','type','Status: browser-reviewed.');
  beforeSync=await until(async()=>{const r=await client.call('read_page',{id:page.id});return r.markdown.includes('Status: browser-reviewed.')?r:false},'browser same-line edit received');
  const remoteBefore=git('ls-remote','origin','refs/heads/main').trim();
  caption('Browser and Git agent independently change the SAME status line.\nUse normal POST /api/spaces/:space/sync (the Sync now operation).');await sleep(1800);
  const first=await sync();assert.equal(first.git.status,'conflict');
  const conflict=await until(async()=>{const r=await client.call('read_page',{id:page.id});return r.markdown.includes('<<<<<<<')&&r.markdown.includes('Status: browser-reviewed.')&&r.markdown.includes('Status: agent-reviewed.')?r:false},'both sides visible in conflict');
  assert.equal(git('ls-remote','origin','refs/heads/main').trim(),remoteBefore,'Unresolved merge must not be pushed');
  await until(()=>rendered(session).includes('<<<<<<<'),'real browser conflict visible');
  caption('PASS: conflict is visible with BOTH versions; unresolved merge was NOT pushed.\nAgent reads it and explicitly resolves to retain both reviewers\u2019 statuses.');browser(session,'screenshot',video.out+'/conflict.png');await sleep(3500);
  const resolved=conflict.markdown.replace(/<<<<<<<[^\n]*\n[\s\S]*?=======\n[\s\S]*?>>>>>>>[^\n]*(?:\n|$)/g,'Status: browser-reviewed; agent-reviewed.\n');assert(!resolved.includes('<<<<<<<'));assert(resolved.includes('browser-reviewed; agent-reviewed'));
  await client.call('update_page',{id:page.id,markdown:resolved,baseRevision:conflict.bodyRevision});
  const second=await sync();assert.equal(second.git.status,'clean');
  const verified=await verifyReadbacks(client,page,session,['Status: browser-reviewed; agent-reviewed.']);const remote=remoteFile(page);assert(remote.includes('browser-reviewed; agent-reviewed'));assert(!remote.includes('<<<<<<<'));
  caption('PASS: explicit MCP resolution + Sync publishes the resolved file.\nReload, browser, REST, MCP, current file and remote Git all retain the resolution.');browser(session,'screenshot',video.out+'/result.png');await sleep(3500);
  video.finish({case:kind,status:'PASS',firstSync:first.git.status,unresolvedRemoteRefUnchanged:true,conflictBody:conflict.markdown,explicitResolutionBody:resolved,finalSync:second.git.status,remoteGitContainsResolution:true,...verified,httpTrace,mcpTrace});
 }else{
  if(kind==='gitUndoFinalNewline')await sync();
  typeAtEnd(session,marker);if(kind==='gitUndoFinalNewline')browser(session,'press','Enter');const human=await until(async()=>{const r=await client.call('read_page',{id:page.id});return r.markdown.includes(marker)?r:false},'browser edit received');
  if(kind==='threeWriters'){
   await client.call('update_page',{id:page.id,markdown:human.markdown.replace('MCP field: original.','MCP field: changed by API agent.'),baseRevision:human.bodyRevision});
   await until(()=>rendered(session).includes('MCP field: changed by API agent.'),'MCP edit visible');
  }
  const from=kind.startsWith('gitUndo')?'Status: draft.':'Git field: original.';
  const to=kind.startsWith('gitUndo')?'Status: git-reviewed.':'Git field: changed in repository.';
  caption(kind.startsWith('gitUndo')?'Browser sentence is present. A separate Git clone changes only Status, commits and pushes.':'Browser sentence and MCP edit are live.\nSeparate Git clone changes a different field, commits and pushes.');await sleep(1500);
  const pushed=gitEdit(page,from,to,'Git agent changes independent passage');
  const merged=await sync();assert.equal(merged.git.status,'clean');
  const checks=kind==='threeWriters'?[marker,to,'MCP field: changed by API agent.']:[marker,to];
  const all=await until(async()=>{const r=await client.call('read_page',{id:page.id});return checks.every(x=>r.markdown.includes(x))?r:false},'Git/browser/MCP merged body');
  await until(()=>checks.every(x=>rendered(session).includes(x)),'merged UI visible');
  for(const x of checks)assert(remoteFile(page).includes(x),'Merged remote contains '+x);
  caption('PASS: normal Sync retains all independent edits and publishes them to remote Git.\nNow press Ctrl+Z on the still-open browser to check local Undo.');await sleep(2500);
  browser(session,'click','.cm-content[contenteditable=true]');browser(session,'press','Control+z');await sleep(650);
  const undoWorks=!rendered(session).includes(marker);
  const undone=await until(async()=>{const r=await client.call('read_page',{id:page.id});return r.markdown.includes(marker)===!undoWorks?r:false},'Git sync Undo readback');assert(undone.markdown.includes(to));if(kind==='threeWriters')assert(undone.markdown.includes('MCP field: changed by API agent.'));
  caption(undoWorks?'PASS: browser Undo removes only its own sentence; Git/API edits remain.':'FAIL: browser sentence cannot be undone after Git sync.');browser(session,'screenshot',video.out+'/undo.png');await sleep(2500);
  browser(session,'press','Control+y');await until(()=>rendered(session).includes(marker),'Redo after sync');
  const finalSync=await sync();assert.equal(finalSync.git.status,'clean');
  const verified=await verifyReadbacks(client,page,session,checks);for(const x of checks)assert(remoteFile(page).includes(x));
  caption('Reload + real readbacks agree, including the remote Git file.\n'+(undoWorks?'Git and ordinary browser/API edits coexist with useful Undo.':'Data retained, but useful browser Undo was lost in this case.'));browser(session,'screenshot',video.out+'/result.png');await sleep(3500);
  video.finish({case:kind,status:undoWorks?'PASS':'FAIL',agentGitCommit:pushed,normalSyncStatus:merged.git.status,mergedBody:all.markdown,bodyAfterUndo:undone.markdown,undoRemovedOnlyBrowserSentence:undoWorks,remoteGitContainsAllChecks:true,...verified,httpTrace,mcpTrace});
 }
 console.log(kind+': completed');
}catch(error){writeFileSync(root+'/'+kind+'-failure.private.txt',String(error.stack));throw error;}
finally{await client.close();browser(session,'close');}
