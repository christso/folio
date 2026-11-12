import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {fixture,runtime,root,authenticate,healthy,browser,evaluate,rest,mcpConnection,fileText,until,sleep,sha,recording} from './harness.mjs';
const mode=process.argv[2];assert(['control','fault'].includes(mode));
const session='folio-recovery-proposal-'+mode;
const title=mode==='fault'?'Proposal retry evidence':'Proposal control';
const stem=mode==='fault'?'proposal-retry-evidence':'proposal-control';
const marker='PROPOSED-BODY-MARKER-'+mode.toUpperCase();
await healthy();const state=await authenticate();const mcp=await mcpConnection();
const created=await mcp.call('create_page',{space:fixture.reviewSpace,parentPath:'',title,markdown:'# '+title+'\n\n'+marker+'\n'});
assert.equal(created.status,'proposed');assert(created.proposalId);
const proposalId=created.proposalId;
const tree=async()=>{
 const r=await rest('GET','/api/spaces/'+fixture.reviewSpace+'/tree');assert.equal(r.status,200);
 const flat=nodes=>nodes.flatMap(n=>[n,...flat(n.children??[])]);
 return flat(r.body.tree).filter(n=>n.path===stem+'.md'||n.path===stem+'-2.md');
};
assert.equal((await tree()).length,0,'Unique untouched fixture required');
browser(session,'--state',state,'open',new URL('/s/'+fixture.reviewSpace+'?review='+proposalId,runtime.base).href);
browser(session,'set','viewport','1280','720');
const hasAccept=()=>evaluate(session,'Array.from(document.querySelectorAll("button")).some(x=>x.textContent.trim()==="Accept"&&!x.disabled)');
await until(hasAccept,'review Accept button');
const video=await recording(session,'proposal-'+mode,{editor:false});
await until(hasAccept,'Accept after capture reload');
evaluate(session,'Array.from(document.querySelectorAll("button")).find(x=>x.textContent.trim()==="Got it")?.click();true');
const caption=video.caption;
caption('Clean upstream '+runtime.baseline.slice(0,12)+' | '+mode.toUpperCase()+'\nA real HTTP MCP create_page call produced ONE pending new-page proposal.');await sleep(3000);
const accept=()=>evaluate(session,'Array.from(document.querySelectorAll("button")).find(x=>x.textContent.trim()==="Accept"&&!x.disabled).click();true');
let afterFailure=null,firstPage=null;
try {
 if(mode==='fault') {
  writeFileSync(root+'/fault-control.json',JSON.stringify({kind:'rename-once',id:'body-once-'+stem,target:'/app/data/repos/'+fixture.reviewSpace+'/'+stem+'.md',bodyMarker:marker}));
  caption('Inject ONE EIO on the proposed BODY atomic rename.\nTitle-only page creation is allowed. Click the real Accept button.');
 } else caption('No injected fault. Click the real Accept button.');
 accept();
 if(mode==='fault') {
  await until(()=>evaluate(session,'Array.from(document.querySelectorAll("[role=alert]")).some(x=>x.textContent.trim())'),'visible acceptance error');
  afterFailure=(await rest('GET','/api/proposals/'+proposalId)).body;
  assert.equal(afterFailure.status,'pending');assert.equal(afterFailure.resultPageId,null);
  const pages=await tree();assert.equal(pages.length,1);firstPage=pages[0];
  const headingOnly={markdown:fileText(firstPage,fixture.reviewSpace)};
  // Inspect the current file without opening/hydrating the partially created room.
  assert(!headingOnly.markdown.includes(marker));
  caption('Accept shows an error. REST confirms the proposal is pending,\nbut ONE heading-only page already exists and its ID was not retained.');
  browser(session,'screenshot',video.out+'/error.png');await sleep(4000);
  writeFileSync(root+'/fault-control.json','{}\n');
  caption('Storage fault is cleared. Retry the SAME proposal using Accept.');accept();
 }
 const decided=await until(async()=>{const r=(await rest('GET','/api/proposals/'+proposalId)).body;return r.status==='accepted'?r:false},'accepted proposal');
 const pages=await tree();assert.equal(pages.length,mode==='fault'?2:1);
 assert(decided.resultPageId);if(firstPage)assert.notEqual(decided.resultPageId,firstPage.id);
 const readbacks=[];
 for(const p of pages) {
  const http=(await rest('GET','/api/pages/'+p.id)).body;
  const tool=await mcp.call('read_page',{id:p.id});assert.equal(tool.markdown,http.markdown);
  const disk=fileText(p,fixture.reviewSpace);assert.equal(disk.includes(marker),http.markdown.includes(marker));
  readbacks.push({id:p.id,path:p.path,markdown:http.markdown,fileSha256:sha(disk)});
 }
 assert.equal(readbacks.filter(p=>p.markdown.includes(marker)).length,1);
 // Reopen the actual space, then reload so the sidebar is read afresh.
 browser(session,'press','Escape');browser(session,'open',new URL('/s/'+fixture.reviewSpace+'/p/'+decided.resultPageId,runtime.base).href);browser(session,'reload');
 await until(()=>evaluate(session,JSON.stringify(stem)+' && document.body.innerText.includes('+JSON.stringify(title)+')'),'visible resulting sidebar');
 caption(mode==='fault'?'CONFIRMED: retry created a SECOND page at '+stem+'-2.md.\nReload shows duplicate titles. REST, HTTP MCP and both files confirm it.':'CONTROL: one acceptance created ONE complete page.\nReload, REST, HTTP MCP and current file agree.');
 browser(session,'screenshot',video.out+'/result.png');await sleep(5000);
 const replay=await rest('POST','/api/proposals/'+proposalId+'/decision',{decision:'accept'});assert.equal(replay.status,409);
 assert.equal((await tree()).length,pages.length);
 video.finish({mode,proposalId,firstFailure:afterFailure?{status:afterFailure.status,resultPageId:afterFailure.resultPageId}:null,injectedBodyFailures:mode==='fault'?1:0,acceptedResultPageId:decided.resultPageId,pageCount:pages.length,pages:readbacks,replayAfterSuccessStatus:replay.status,restMcpFileAgree:true,reloadShowsTitles:true,faultDescription:mode==='fault'?'External one-shot fs.rename EIO for exact body marker/path only; title creation permitted; error before rename. Shim normally inert; upstream source unmodified.':'No injected failure.'});
 console.log(mode+': proposal assertions passed');
} finally {
 writeFileSync(root+'/fault-control.json','{}\n');await mcp.close();browser(session,'close');
}
