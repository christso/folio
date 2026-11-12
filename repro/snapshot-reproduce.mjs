import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {fixture,runtime,root,authenticate,healthy,openEditor,browser,evaluate,rendered,typeAtEnd,pg,rest,mcpConnection,fileText,restartApp,run,until,sleep,sha,recording,sourceAfterReload} from './harness.mjs';

const mode=process.argv[2];assert(['control','fault'].includes(mode));
const page=fixture.pages[mode==='control'?'snapshotControl':'snapshotFault'];
const session='folio-recovery-snapshot-'+mode;
await healthy();const state=await authenticate();await openEditor(session,page,state);
await until(()=>rendered(session).includes(page.marker),'baseline visible');
const db=pg();await db.connect();
const row=await until(async()=>{const r=await db.query('SELECT snapshot FROM ydoc_state WHERE page_id=$1',[page.id]);return r.rows[0]?.snapshot?.length?r.rows[0]:false},'stored initial snapshot');
const snapshotBeforeSha256=sha(row.snapshot);
const video=await recording(session,'snapshot-'+mode);
const captions=video.caption;
captions('Clean upstream '+runtime.baseline.slice(0,12)+' | '+mode.toUpperCase()+'\nBaseline saved once. Existing collaborative snapshot confirmed.');await sleep(2300);
browser(session,'set','offline','on');
run('docker',['stop',runtime.appContainer]);
const offlineMarker='Offline addition: retain this line.';
typeAtEnd(session,offlineMarker);
assert(rendered(session).includes(offlineMarker));
// Do not warm the cold room via REST/MCP before injecting the lookup failure.
const before=fileText(page);
assert(!before.includes(offlineMarker),'Offline edit must not already be on server');
captions('Browser is offline; only the disposable app was restarted.\nType an offline sentence. Current Markdown file confirms it is still unsent.');await sleep(2500);
let cancelledLookupCount=0;
let cancelledPid=null;
const lock=pg();await lock.connect();let locked=false;
try {
 if(mode==='fault') {
  await lock.query('BEGIN');await lock.query('LOCK TABLE ydoc_state IN ACCESS EXCLUSIVE MODE');locked=true;
 }
 run('docker',['start',runtime.appContainer]);await healthy();
 browser(session,'set','offline','off');
 if(mode==='fault') {
  const blocked=await until(async()=>{
   const r=await db.query("SELECT pid, query FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%SELECT snapshot, file_body_sha256 FROM ydoc_state WHERE page_id = $1%'");
   return r.rows.length===1?r.rows[0]:false;
  },'one blocked upstream snapshot lookup');
  cancelledPid=blocked.pid;
  const r=await db.query('SELECT pg_cancel_backend($1) AS cancelled',[cancelledPid]);assert.equal(r.rows[0].cancelled,true);cancelledLookupCount++;
  await lock.query('COMMIT');locked=false;
  captions('Inject ONE transient snapshot-read failure (PostgreSQL cancellation).\nThe scheduling lock is released immediately; storage can save again.');
 } else captions('Reconnect with no storage fault.\nThe server restores the existing collaborative history.');
 const expected=mode==='fault'?2:1;
 const count=s=>s.split(page.marker).length-1;
 await until(()=>{const s=rendered(session);return count(s)===expected&&s.includes(offlineMarker)},'expected baseline count after reconnect',35000);
 await sleep(1500);
 const mcp=await mcpConnection();
 const fromMcp=await until(async()=>{const r=await mcp.call('read_page',{id:page.id});return count(r.markdown)===expected&&r.markdown.includes(offlineMarker)?r:false},'settled HTTP MCP readback');
 const fromRest=await until(async()=>{const r=(await rest('GET','/api/pages/'+page.id)).body;return r.markdown===fromMcp.markdown?r:false},'settled REST readback');
 const fromFile=await until(()=>{const s=fileText(page);return count(s)===expected&&s.includes(offlineMarker)?s:false},'same result in current Markdown file');
 assert.equal(count(fromMcp.markdown),expected);assert.equal(count(fromRest.markdown),expected);assert.equal(fromMcp.markdown,fromRest.markdown);
 assert.equal(fromMcp.markdown.split(offlineMarker).length-1,1);
 captions(mode==='fault'?'FAULT: the baseline text now appears TWICE; the offline sentence appears once.\nReal browser, REST, HTTP MCP and current file agree.':'CONTROL: baseline and offline sentence each appear ONCE.\nReal browser, REST, HTTP MCP and current file agree.');
 browser(session,'screenshot',video.out+'/result.png');await sleep(4000);
 const reloaded=await sourceAfterReload(session);assert.equal(count(reloaded),expected);assert(reloaded.includes(offlineMarker));
 captions('Reload retains the same result.\n'+(mode==='fault'?'A failed read was treated as absent history; reconnect merged two copies.':'Ordinary restart/reconnect preserves one copy.'));await sleep(3500);
 video.finish({mode,pageId:page.id,pagePath:page.path,snapshotBeforeSha256,cancelledLookupCount,cancelledPid,baselineCount:expected,offlineMarkerCount:1,bodyAfterReconnect:fromMcp.markdown,restMcpMatch:true,fileSha256:sha(fromFile),reloadMatches:true,faultDescription:mode==='fault'?'One SELECT cancelled using pg_cancel_backend; ACCESS EXCLUSIVE lock used only to select the query deterministically; no snapshot deletion, schema change or source patch.':'No injected fault.'});
 await mcp.close();console.log(mode+': snapshot assertions passed');
} catch(error) {
 writeFileSync(root+'/snapshot-'+mode+'-failure.private.txt',String(error.stack));
 throw error;
} finally {
 if(locked)await lock.query('ROLLBACK').catch(()=>{});
 await lock.end();await db.end();
 browser(session,'close');
}
