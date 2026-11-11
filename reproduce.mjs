import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const source = process.env.FOLIO_SOURCE;
assert(source, 'FOLIO_SOURCE must name the pinned Folio checkout with npm dependencies');
const baseline = '94f4e0a6e9f83bd84f80ae097e47910242b7bd99';
const fixed = process.env.FOLIO_FIXED_COMMIT;
const mode = process.argv[2];
assert(['before', 'after'].includes(mode));
assert(mode === 'before' || /^[0-9a-f]{40}$/.test(fixed ?? ''), 'FOLIO_FIXED_COMMIT must pin the after checkout');
const container = process.env.FOLIO_EVIDENCE_CONTAINER ?? 'folio-edit-history-' + mode;
assert(container.startsWith('folio-edit-history-'), 'use a disposable folio-edit-history-* container');
const base = new URL(process.env.FOLIO_EVIDENCE_URL ?? 'http://127.0.0.1:' + (mode === 'before' ? 54893 : 54894));
assert(['127.0.0.1','localhost'].includes(base.hostname), 'use a loopback-only target');
const session = 'folio-edit-history-' + mode;
const out = root + '/' + mode;
mkdirSync(out, { recursive: true });
const require = createRequire(source + '/package.json');
const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
const { StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')));
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const sha = s => createHash('sha256').update(s).digest('hex');
function run(binary,args) {
 const r=spawnSync(binary,args,{encoding:'utf8',timeout:45000,maxBuffer:8e6});
 assert.equal(r.status,0,binary+' failed: '+String(r.stderr).slice(-1200));
 return r.stdout;
}
function browser(...args) {
 const r=JSON.parse(run('agent-browser',['--json','--session',session,...args]));
 assert(r.success,JSON.stringify(r.error));return r.data;
}
const evaluate = code => browser('eval',code).result;
async function until(fn,label,timeout=25000) {
 const end=Date.now()+timeout;
 while(Date.now()<end){const x=await fn();if(x)return x;await sleep(100);}
 throw new Error('Timed out: '+label);
}
const healthy=()=>until(async()=>{try{return(await fetch(new URL('/api/health',base))).ok;}catch{return false;}},'server startup');
await healthy();
const runtimeSourceHashes = {};
for (const file of ['server/collab.ts','server/mcp.ts','server/routes.ts','shared/contracts.ts']) {
 const runtimeSource=run('docker',['exec',container,'cat','/app/'+file]);
 assert.equal(runtimeSource,run('git',['-C',source,'show',(mode==='before'?baseline:fixed)+':'+file]));
 runtimeSourceHashes[file]=sha(runtimeSource);
}
run('docker',['cp',root+'/seed.mjs',container+':/app/history-seed.mjs']);
const fixture=JSON.parse(run('docker',['exec',container,'./node_modules/.bin/tsx','/app/history-seed.mjs']).trim().split('\n').at(-1));
run('docker',['restart',container]);await healthy();
const client=new Client({name:'edit-history-evidence',version:'1.0.0'});
await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',base),{requestInit:{headers:{Authorization:'Bearer '+fixture.token}}}));
async function mcp(name,args){const r=await client.callTool({name,arguments:args});assert(!r.isError,'MCP '+name+' failed');return r.structuredContent??JSON.parse(r.content.find(c=>c.type==='text').text);}
browser('open',base.href);browser('set','viewport','1280','720');browser('wait','input[type=email]');
browser('fill','input[type=email]','reviewer@example.com');browser('fill','input[type=password]','synthetic-evidence-password');browser('click','button[type=submit]');
await until(()=>evaluate('!document.querySelector("input[type=password]")'),'login');
const pageUrl=new URL('/s/'+fixture.space+'/p/'+fixture.pageId,base).href;
browser('open',pageUrl);
await until(()=>evaluate('Array.from(document.querySelectorAll("button")).some(x=>x.textContent.trim()==="Source")'),'editor');
browser('record','start',out+'/capture.webm',pageUrl);
await until(()=>evaluate('Array.from(document.querySelectorAll("button")).some(x=>x.textContent.trim()==="Source")'),'recording editor');
evaluate('Array.from(document.querySelectorAll("button")).find(x=>x.textContent.trim()==="Source").click();true');
browser('wait','.cm-content[contenteditable=true]');
const start=performance.now();
const captions=[];
const caption=text=>captions.push({at:(performance.now()-start)/1000,text});
caption(mode.toUpperCase()+': '+(mode==='before'?'clean upstream '+baseline.slice(0,12):'same baseline + focused patch '+fixed.slice(0,12))+'\nReal browser keyboard input and real HTTP MCP. Synthetic page.');
await sleep(2500);
const marker='Browser note: keep this sentence.';
browser('click','.cm-content[contenteditable=true]');browser('press','Control+End');browser('press','Enter');browser('keyboard','type',marker);
const typed=await until(async()=>{const r=await mcp('read_page',{id:fixture.pageId});return r.markdown.includes(marker)?r:false;},'typed sentence on server');
caption('Type a sentence in the browser.\nHTTP MCP confirms it; the agent reads this CURRENT body and revision.');
await sleep(2500);
const proposed=typed.markdown.replace('Status: draft.','Status: reviewed.');assert.notEqual(proposed,typed.markdown);
await mcp('update_page',{id:fixture.pageId,markdown:proposed,baseRevision:typed.bodyRevision});
const accepted=await mcp('read_page',{id:fixture.pageId});assert.equal(accepted.markdown,proposed);
await until(()=>evaluate('document.querySelector(".cm-content").innerText.includes("Status: reviewed.")'),'agent change visible');
caption('MCP changes only Status, supplying the matching baseRevision.\nBoth changes are present. No stale write, injected lock or acceptance delay.');
await sleep(3000);
assert(evaluate('Boolean(document.activeElement?.closest(".cm-content"))'),'editor must retain keyboard focus');
browser('press','Control+z');await sleep(750);
const undone=await mcp('read_page',{id:fixture.pageId});
const renderedUndo=evaluate('document.querySelector(".cm-content").innerText');
const undoRemovedOwnSentence=!undone.markdown.includes(marker);
assert.equal(renderedUndo.includes(marker),!undoRemovedOwnSentence);
assert(undone.markdown.includes('Status: reviewed.'),'Undo must preserve the agent change');
console.log(JSON.stringify({mode,undoRemovedOwnSentence,agentChangeRetained:undone.markdown.includes('Status: reviewed.'),markdownAfterUndo:undone.markdown}));
assert.equal(undoRemovedOwnSentence,mode==='after','browser Undo should remove the local sentence only after the fix');
caption(mode==='before'?'BEFORE: press Ctrl+Z. The browser sentence stays.\nA normal API update has destroyed its useful Undo history.':'AFTER: press Ctrl+Z. Only the browser sentence disappears.\nThe agent\u2019s Status change stays.');
browser('screenshot',out+'/undo.png');await sleep(4000);
browser('press','Control+y');await sleep(600);
const redone=await mcp('read_page',{id:fixture.pageId});assert(redone.markdown.includes(marker));assert(redone.markdown.includes('Status: reviewed.'));
caption(mode==='before'?'Ctrl+Y leaves the same text; Ctrl+Z did not undo the sentence.\nThe API request succeeded, but local editing history was lost.':'Ctrl+Y restores the browser sentence.\nUndo and Redo preserve the agent\u2019s independent change.');
await sleep(3500);
browser('reload');await until(()=>evaluate('Array.from(document.querySelectorAll("button")).some(x=>x.textContent.trim()==="Source")'),'reload');
evaluate('Array.from(document.querySelectorAll("button")).find(x=>x.textContent.trim()==="Source").click();true');browser('wait','.cm-content[contenteditable=true]');
const rest=evaluate('(async()=>await(await fetch('+JSON.stringify('/api/pages/'+fixture.pageId)+')).json())()');
const final=await mcp('read_page',{id:fixture.pageId});assert.equal(rest.markdown,final.markdown);assert.equal(final.markdown,redone.markdown);
const rendered=evaluate('document.querySelector(".cm-content").innerText');assert(rendered.includes(marker));assert(rendered.includes('Status: reviewed.'));
const file=await until(()=>{const s=run('docker',['exec',container,'cat','/app/data/repos/'+fixture.space+'/'+fixture.path]);return s.includes(marker)&&s.includes('Status: reviewed.')?s:false;},'current file');
caption('Reload, browser and REST/MCP readbacks agree.\nThe difference is whether your own sentence can be undone after the API edit.');
await sleep(3500);browser('record','stop');
const receipt={mode,baselineCommit:baseline,fixedCommit:mode==='after'?fixed:null,syntheticOnly:true,matchingBaseRevision:true,noInjectedScheduling:true,realBrowserKeyboard:true,realHttpMcp:true,typedBody:typed.markdown,acceptedBody:accepted.markdown,bodyAfterUndo:undone.markdown,undoRemovedOwnSentence,agentChangeRetainedAfterUndo:true,bodyAfterRedo:redone.markdown,reloadRestMcpMatched:true,currentFileSha256:sha(file),runtimeSourceHashes};
writeFileSync(root+'/'+mode+'-receipt.json',JSON.stringify(receipt,null,2)+'\n');
writeFileSync(root+'/'+mode+'-captions.json',JSON.stringify(captions,null,2)+'\n');
await client.close();browser('close');console.log(mode+': all assertions passed');
