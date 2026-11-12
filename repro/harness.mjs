import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const root=path.dirname(fileURLToPath(import.meta.url));
export const runtime=JSON.parse(readFileSync(root+'/runtime.json'));
export const fixture=JSON.parse(readFileSync(root+'/fixture.private.json'));
export const source=process.env.FOLIO_SOURCE;assert(source);
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const sha=s=>createHash('sha256').update(s).digest('hex');
export function run(bin,args,cwd){const r=spawnSync(bin,args,{cwd,encoding:'utf8',timeout:60000,maxBuffer:12e6});if(r.status!==0){writeFileSync(root+'/command-failure.private.log',r.stdout+'\n'+r.stderr,{mode:0o600});throw Error('Command failed: '+bin);}return r.stdout;}
export function browser(session,...args){const r=JSON.parse(run('agent-browser',['--json','--session',session,...args]));assert(r.success,String(r.error));return r.data;}
export const evaluate=(s,code)=>browser(s,'eval',code).result;
export async function until(fn,label,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){const x=await fn();if(x)return x;await sleep(120);}throw Error('Timed out: '+label);}
let cookie;export const httpTrace=[];
export async function http(method,p,body,{agent=false,raw=false}={}){
 const r=await fetch(runtime.base+p,{method,headers:{...(agent?{Authorization:'Bearer '+fixture.auth.token}:cookie?{Cookie:cookie}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const text=await r.text();let value;try{value=JSON.parse(text)}catch{value={text}};
 httpTrace.push({method,path:p,status:r.status,requestKeys:body?Object.keys(body):[]});
 return {status:r.status,body:value,cookies:r.headers.getSetCookie()};
}
export async function authenticate(){const r=await http('POST','/api/auth/login',{email:fixture.auth.email,password:fixture.auth.password});assert.equal(r.status,200);cookie=r.cookies.map(x=>x.split(';',1)[0]).join('; ');const state=root+'/browser-state.private.json';writeFileSync(state,JSON.stringify({cookies:r.cookies.map(x=>{const pair=x.split(';',1)[0],at=pair.indexOf('=');return{name:pair.slice(0,at),value:pair.slice(at+1),domain:'127.0.0.1',path:'/',expires:Math.floor(Date.now()/1000)+7200,httpOnly:true,secure:false,sameSite:'Lax'}}),origins:[]}),{mode:0o600});return state;}
const require=createRequire(source+'/package.json');
const {Client}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
const {StreamableHTTPClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')));
export const mcpTrace=[];
export async function mcpConnection(){const client=new Client({name:'upstream-retirement-verification',version:'1.0.0'});await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',runtime.base),{requestInit:{headers:{Authorization:'Bearer '+fixture.auth.token}}}));const raw=async(name,args)=>{const r=await client.callTool({name,arguments:args});mcpTrace.push({name,inputKeys:Object.keys(args),isError:Boolean(r.isError)});return r;};return {close:()=>client.close(),raw,call:async(name,args)=>{const r=await raw(name,args);assert(!r.isError,'MCP '+name+' failed');return r.structuredContent??JSON.parse(r.content.find(x=>x.type==='text').text);}};}
export async function sourceMode(session){await until(()=>evaluate(session,'Array.from(document.querySelectorAll("button")).some(x=>x.textContent.trim()==="Source")'),'editor Source button');evaluate(session,'Array.from(document.querySelectorAll("button")).find(x=>x.textContent.trim()==="Got it")?.click();true');if(!evaluate(session,'Boolean(document.querySelector(".cm-content[contenteditable=true]"))'))evaluate(session,'Array.from(document.querySelectorAll("button")).find(x=>x.textContent.trim()==="Source").click();true');browser(session,'wait','.cm-content[contenteditable=true]');}
export async function openEditor(session,page,state){browser(session,'--state',state,'open',runtime.base+'/s/'+fixture.space+'/p/'+page.id);browser(session,'set','viewport','1280','720');await sourceMode(session);await until(()=>rendered(session).includes(page.title),'page title rendered');}
export const rendered=session=>evaluate(session,'document.querySelector(".cm-content")?.innerText??""');
export function typeAtEnd(session,text){browser(session,'click','.cm-content[contenteditable=true]');browser(session,'press','Control+End');browser(session,'press','Enter');browser(session,'keyboard','type',text);}
export function typeAfterLine(session,line,text){const n=evaluate(session,'(()=>{const ls=Array.from(document.querySelectorAll(".cm-content > .cm-line"));const target=ls.find(x=>x.innerText.includes('+JSON.stringify(line)+'));return target?Array.from(target.parentElement.children).indexOf(target)+1:null})()');assert(n,'Visible editor line required');browser(session,'click','.cm-content > .cm-line:nth-child('+n+')');browser(session,'press','End');browser(session,'press','Enter');browser(session,'keyboard','type',text);}
export const git=(...args)=>run('git',['-c','user.name=Git Agent','-c','user.email=git-agent@example.com',...args],root+'/agent-git');
export function gitEdit(page,from,to,message){git('pull','--no-rebase','origin','main');const file=root+'/agent-git/'+page.path;const old=readFileSync(file,'utf8');assert(old.includes(from),'Git replacement must match');const next=old.replace(from,to);assert.notEqual(next,old);writeFileSync(file,next);git('add',page.path);git('commit','-m',message);git('push','origin','main');return git('rev-parse','HEAD').trim();}
export async function sync(){const r=await http('POST','/api/spaces/'+fixture.space+'/sync',{}, {agent:true});assert.equal(r.status,200,'Normal sync endpoint');return r.body;}
export const currentFile=page=>run('docker',['exec',runtime.appContainer,'cat','/app/data/repos/'+fixture.space+'/'+page.path]);
export const remoteFile=page=>run('git',['--git-dir='+root+'/git-remotes/shared.git','-c','safe.directory='+root+'/git-remotes/shared.git','show','main:'+page.path]);
export async function reloadSource(session){browser(session,'reload');await sourceMode(session);return rendered(session);}
export async function recording(session,name,{editor=true}={}){const out=root+'/'+name;mkdirSync(out,{recursive:true});const started=performance.now();browser(session,'record','start',out+'/capture.webm');if(editor)await sourceMode(session);const captions=[];const caption=text=>{captions.push({at:(performance.now()-started)/1000,text});console.log(JSON.stringify({case:name,caption:text.replaceAll('\n',' ')}));};return{out,caption,finish:receipt=>{browser(session,'record','stop');writeFileSync(out+'/receipt.json',JSON.stringify({...receipt,baseline:runtime.baseline,fixedCommit:runtime.fixedCommit,sourceHashes:runtime.sourceHashes,syntheticOnly:true,noFaultInjection:true,realBrowserKeyboard:true,realHttpMcp:true},null,2)+'\n');writeFileSync(out+'/captions.json',JSON.stringify(captions,null,2)+'\n');}};}
export async function verifyReadbacks(client,page,session,checks){const tool=await until(async()=>{const r=await client.call('read_page',{id:page.id});return checks.every(x=>r.markdown.includes(x))?r:false},'MCP contents');const rest=(await http('GET','/api/pages/'+page.id,undefined,{agent:true})).body;assert.equal(rest.markdown,tool.markdown);const file=await until(()=>{const s=currentFile(page);return checks.every(x=>s.includes(x))?s:false},'current file');const visible=await reloadSource(session);for(const x of checks)assert(visible.includes(x),'Reload visible '+x);return{markdown:tool.markdown,fileSha256:sha(file),restMcpMatch:true,reloadRetainsChecks:true};}
