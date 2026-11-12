import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const Y=createRequire(process.env.FOLIO_SOURCE+'/package.json')('yjs');
import {writeFileSync} from 'node:fs';
import {fixture,runtime,root,authenticate,healthy,openEditor,browser,evaluate,rendered,typeAtEnd,pg,rest,mcpConnection,fileText,until,sleep,sha,recording,restartApp,run} from './harness.mjs';
const mode=process.argv[2];assert(['control','fault'].includes(mode));
const session='folio-recovery-durability-'+mode;
await healthy();const state=await authenticate();const mcp=await mcpConnection();
const marker='DURABILITY-EDIT-'+mode.toUpperCase();
let page=fixture.pages.saveFault;
if(mode==='control') {
 const created=await mcp.call('create_page',{space:fixture.recoverySpace,parentPath:'',title:'Durability control '+Date.now(),markdown:'# Durability control\n\nBASELINE-DURABILITY-CONTROL\n'});
 assert(created.id);page={...created,marker:'BASELINE-DURABILITY-CONTROL'};
}
await openEditor(session,page,state);await until(()=>rendered(session).includes(page.marker),'saved baseline');
const db=pg();await db.connect();
const row=await until(async()=>{const r=await db.query('SELECT snapshot FROM ydoc_state WHERE page_id=$1',[page.id]);return r.rows[0]?.snapshot?.length?r.rows[0]:false},'baseline snapshot');
const snapshotBeforeSha256=sha(row.snapshot),fileBefore=fileText(page);
const video=await recording(session,'durability-'+mode);const caption=video.caption;
caption('Clean upstream '+runtime.baseline.slice(0,12)+' | '+mode.toUpperCase()+'\nBaseline file and collaborative snapshot are saved.');await sleep(2500);
let constraint=false;
const snapshotSha=async()=>sha((await db.query('SELECT snapshot FROM ydoc_state WHERE page_id=$1',[page.id])).rows[0].snapshot);
const localCopy=()=>evaluate(session,'indexedDB.databases().then(xs=>xs.some(x=>x.name==='+JSON.stringify('folio-y-'+page.id)+'))');
try {
 if(mode==='fault') {
  assert(/^[A-Z0-9]+$/.test(page.id));
  await db.query("ALTER TABLE ydoc_state ADD CONSTRAINT audit_snapshot_write_unavailable CHECK (page_id <> '"+page.id+"') NOT VALID");constraint=true;
  writeFileSync(root+'/fault-control.json',JSON.stringify({kind:'rename-block',id:'durability-body',target:'/app/data/repos/'+fixture.recoverySpace+'/'+page.path,bodyMarker:marker}));
  caption('Inject TWO save failures for this page: file rename EIO and snapshot write rejection.\nThe socket stays connected; existing durable baseline is kept.');
 } else caption('No injected storage failures. Type a real browser edit.');
 typeAtEnd(session,marker);await until(()=>rendered(session).includes(marker),'typed edit visible');
 const memory=await until(async()=>{const r=(await rest('GET','/api/pages/'+page.id)).body;return r.markdown.includes(marker)?r:false},'server live-room readback');
 if(mode==='fault') {
  await sleep(5000);assert.equal(fileText(page),fileBefore);assert.equal(await snapshotSha(),snapshotBeforeSha256);
 } else await until(()=>fileText(page).includes(marker),'durable current file');
 await until(localCopy,'browser recovery database exists before navigation');
 // Read existing persisted updates, without changing the browser document.
 const updates=evaluate(session,'new Promise((resolve,reject)=>{const q=indexedDB.open('+JSON.stringify('folio-y-'+page.id)+');q.onerror=()=>reject(q.error);q.onsuccess=()=>{const db=q.result;const tx=db.transaction("updates","readonly");const read=tx.objectStore("updates").getAll();tx.oncomplete=()=>{const values=read.result.map(v=>Array.from(new Uint8Array(v)));db.close();resolve(values)};tx.onerror=()=>reject(tx.error)}})');
 const persisted=new Y.Doc();for(const update of updates)Y.applyUpdate(persisted,Uint8Array.from(update));
 assert(persisted.getText('content').toString().includes(marker),'Browser recovery DB must actually contain edit before navigation');persisted.destroy();
 const status=evaluate(session,'Array.from(document.querySelectorAll(".folio-editor__status")).map(x=>({state:x.dataset.status,label:x.getAttribute("aria-label")}))');
 caption(mode==='fault'?'Live REST read contains the edit, but the file and snapshot are UNCHANGED.\nThe browser still shows the edit; its local recovery database exists.':'File saved the browser edit. Its local recovery database also exists.');await sleep(3500);
 // Use a real in-app sidebar link, so the editor unmounts through normal navigation.
 const destination=fixture.pages.snapshotControl.id;
 const selector='[data-tree-page-id="'+destination+'"]';
 await until(()=>evaluate(session,'Boolean(document.querySelector('+JSON.stringify(selector)+'))'),'actual sidebar link');
 browser(session,'click',selector);
 await until(()=>evaluate(session,'location.pathname.endsWith('+JSON.stringify('/p/'+destination)+')'),'navigated to another page');
 await until(async()=>!(await localCopy()),'local recovery database removed');
 if(mode==='fault'){assert.equal(fileText(page),fileBefore);assert.equal(await snapshotSha(),snapshotBeforeSha256);}
 caption(mode==='fault'?'Navigate to another page. Folio DELETES the local recovery database\nwhile neither server save contains the edit (asserted via IndexedDB, file and SQL).':'Navigate to another page. Folio clears the local copy after the normal save.');await sleep(3500);
 // Crash only the named disposable app. Keep faults armed until memory is gone.
 run('docker',['kill','--signal=KILL',runtime.appContainer]);
 writeFileSync(root+'/fault-control.json','{}\n');
 if(constraint){await db.query('ALTER TABLE ydoc_state DROP CONSTRAINT audit_snapshot_write_unavailable');constraint=false;}
 run('docker',['start',runtime.appContainer]);await healthy();
 await openEditor(session,page,state);
 const final=await until(()=>{const s=rendered(session);return s.includes(page.marker)?s:false},'page reopened after disposable app crash');
 const http=(await rest('GET','/api/pages/'+page.id)).body;const tool=await mcp.call('read_page',{id:page.id});
 assert.equal(http.markdown,tool.markdown);assert.equal(final.includes(marker),mode==='control');assert.equal(tool.markdown.includes(marker),mode==='control');assert.equal(fileText(page).includes(marker),mode==='control');
 caption(mode==='fault'?'CONFIRMED: after the disposable server loses memory, the edit is GONE.\nBrowser, REST, HTTP MCP and current file all show the older baseline.':'CONTROL: after the same restart, the browser edit is retained.\nBrowser, REST, HTTP MCP and current file agree.');
 browser(session,'screenshot',video.out+'/result.png');await sleep(5000);
 video.finish({mode,pageId:page.id,pagePath:page.path,marker,storageFailuresInjected:mode==='fault'?['exact-page fs.rename EIO','exact-page ydoc_state write CHECK rejection']:[],snapshotBeforeSha256,fileBeforeSha256:sha(fileBefore),liveRoomContainedEdit:memory.markdown.includes(marker),badgeObserved:status,localRecoveryDatabaseBeforeNavigation:true,localRecoveryDatabaseContainedEditBeforeNavigation:true,localRecoveryDatabaseAfterNavigation:false,editRetainedAfterServerCrash:tool.markdown.includes(marker),finalMarkdown:tool.markdown,restMcpFileAgree:true,faultDescription:mode==='fault'?'Two deliberately injected unavailable durable saves, followed by SIGKILL of only disposable app; not a claim of single-store failure data loss. Source unmodified; PostgreSQL CHECK scoped to synthetic page and removed after crash.':'No injected save failures; same SIGKILL/reopen.'});
 console.log(mode+': durability assertions passed');
} finally {
 writeFileSync(root+'/fault-control.json','{}\n');
 if(constraint)await db.query('ALTER TABLE ydoc_state DROP CONSTRAINT audit_snapshot_write_unavailable').catch(()=>{});
 await db.end();await mcp.close();browser(session,'close');
}
