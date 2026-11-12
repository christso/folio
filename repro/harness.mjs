import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const root=path.dirname(fileURLToPath(import.meta.url));
export const runtime=JSON.parse(readFileSync(root+'/runtime.json','utf8'));
export const fixture=JSON.parse(readFileSync(root+'/fixture.private.json','utf8'));
export const base=new URL(runtime.base);
assert(base.hostname==='127.0.0.1' && runtime.appContainer==='folio-recovery-audit-app');
export const source=process.env.FOLIO_SOURCE;
assert(source,'Set FOLIO_SOURCE to the owned checkout with installed dependencies');
const require=createRequire(source+'/package.json');
export const PgClient=require('pg').Client;
const {Client}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
const {StreamableHTTPClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')));
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const sha=s=>createHash('sha256').update(s).digest('hex');
export function run(binary,args,timeout=60000) {
 const r=spawnSync(binary,args,{encoding:'utf8',timeout,maxBuffer:12e6});
 if(r.status!==0) {
  writeFileSync(root+'/last-command-failure.private.log',r.stdout+'\n'+r.stderr,{mode:0o600});
  throw new Error(binary+' failed; inspect protected runtime log');
 }
 return r.stdout;
}
export function browser(session,...args) {
 const r=JSON.parse(run('agent-browser',['--json','--session',session,...args]));
 assert(r.success,'Browser command failed: '+String(r.error));return r.data;
}
export const evaluate=(session,js)=>browser(session,'eval',js).result;
export async function until(fn,label,timeout=30000) {
 const end=Date.now()+timeout;
 while(Date.now()<end) { const value=await fn(); if(value)return value; await sleep(150); }
 throw new Error('Timed out: '+label);
}
export const healthy=()=>until(async()=>{try{return(await fetch(new URL('/api/health',base))).ok}catch{return false}},'disposable server health');
let cookie;
export async function authenticate() {
 const r=await fetch(new URL('/api/auth/login',base),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:fixture.auth.email,password:fixture.auth.password})});
 assert.equal(r.status,200,'Synthetic login must succeed');
 const values=r.headers.getSetCookie();assert(values.length>0);
 cookie=values.map(v=>v.split(';',1)[0]).join('; ');
 const cookies=values.map(v=>{
  const pair=v.split(';',1)[0],at=pair.indexOf('=');
  return {name:pair.slice(0,at),value:pair.slice(at+1),domain:base.hostname,path:'/',expires:Math.floor(Date.now()/1000)+7200,httpOnly:true,secure:false,sameSite:'Lax'};
 });
 const state=root+'/browser-state.private.json';writeFileSync(state,JSON.stringify({cookies,origins:[]}),{mode:0o600});
 return state;
}
export async function rest(method,url,body) {
 assert(cookie,'Call authenticate first');
 const r=await fetch(new URL(url,base),{method,headers:{Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const text=await r.text();let json;try{json=JSON.parse(text)}catch{json={text}};
 return {status:r.status,body:json};
}
export async function mcpConnection() {
 const client=new Client({name:'recovery-evidence',version:'1.0.0'});
 await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',base),{requestInit:{headers:{Authorization:'Bearer '+fixture.auth.token}}}));
 return {close:()=>client.close(),call:async(name,args)=>{
  const r=await client.callTool({name,arguments:args});
  assert(!r.isError,'MCP '+name+' failed');
  return r.structuredContent??JSON.parse(r.content.find(c=>c.type==='text').text);
 }};
}
export async function openEditor(session,page,state) {
 const url=new URL('/s/'+fixture.recoverySpace+'/p/'+page.id,base).href;
 browser(session,'--state',state,'open',url);
 browser(session,'set','viewport','1280','720');
 await until(()=>evaluate(session,'Array.from(document.querySelectorAll("button")).some(x=>x.textContent.trim()==="Source")'),'editor');
 evaluate(session,'Array.from(document.querySelectorAll("button")).find(x=>x.textContent.trim()==="Source").click();true');
 browser(session,'wait','.cm-content[contenteditable=true]');
 return url;
}
export const rendered=session=>evaluate(session,'document.querySelector(".cm-content")?.innerText??""');
export function typeAtEnd(session,text) {
 browser(session,'click','.cm-content[contenteditable=true]');browser(session,'press','Control+End');browser(session,'press','Enter');browser(session,'keyboard','type',text);
}
export function pg() {return new PgClient({host:'127.0.0.1',port:runtime.postgresPort,user:'folio',database:'folio',application_name:'recovery-evidence-control'});}
export function fileText(page,space=fixture.recoverySpace) {return readFileSync(root+'/data/repos/'+space+'/'+page.path,'utf8');}
export async function restartApp() {run('docker',['restart',runtime.appContainer]);await healthy();}
export async function recording(session,name,{editor=true}={}) {
 const out=root+'/'+name;mkdirSync(out,{recursive:true});
 const start=performance.now();
 browser(session,'record','start',out+'/capture.webm');
 if(editor) {
 // Recording can reload the page; re-enter Source through the actual UI.
 await until(()=>evaluate(session,'Array.from(document.querySelectorAll(\"button\")).some(x=>x.textContent.trim()===\"Source\")'),'recording editor');
 evaluate(session,'Array.from(document.querySelectorAll(\"button\")).find(x=>x.textContent.trim()===\"Got it\")?.click();true');
 if(!evaluate(session,'Boolean(document.querySelector(\".cm-content[contenteditable=true]\"))')) evaluate(session,'Array.from(document.querySelectorAll(\"button\")).find(x=>x.textContent.trim()===\"Source\").click();true');
 browser(session,'wait','.cm-content[contenteditable=true]');
 }
 const captions=[];
 const caption=text=>{captions.push({at:(performance.now()-start)/1000,text});console.log(JSON.stringify({step:name,caption:text.replaceAll('\n',' ')}));};
 return {out,caption,finish:receipt=>{
  browser(session,'record','stop');
  writeFileSync(out+'/captions.json',JSON.stringify(captions,null,2)+'\n');
  writeFileSync(out+'/receipt.json',JSON.stringify({...receipt,baseline:runtime.baseline,runtimeSourceHashes:runtime.sourceHashes,syntheticOnly:true,realBrowserKeyboard:true},null,2)+'\n');
 }};
}
export async function sourceAfterReload(session) {
 browser(session,'reload');
 await until(()=>evaluate(session,'Array.from(document.querySelectorAll("button")).some(x=>x.textContent.trim()==="Source")'),'reloaded editor');
 evaluate(session,'Array.from(document.querySelectorAll("button")).find(x=>x.textContent.trim()==="Source").click();true');
 browser(session,'wait','.cm-content[contenteditable=true]');return rendered(session);
}
