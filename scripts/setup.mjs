import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.env.FOLIO_RUN_DIR;assert(root);const runtime=JSON.parse(readFileSync(root+'/runtime.json'));
const source=process.env.FOLIO_SOURCE;assert(source);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
for(let i=0;i<150;i++){try{if((await fetch(runtime.base+'/api/health')).ok)break;}catch{}if(i===149)throw Error('Fixture not healthy');await pause(200);}
const cmd=(bin,args)=>{const r=spawnSync(bin,args,{encoding:'utf8',timeout:60000});assert.equal(r.status,0,bin+' failed');return r.stdout;};
runtime.sourceHashes={};for(const file of ['server/collab.ts','server/gitSync.ts','server/mcp.ts','server/routes.ts','shared/contracts.ts','package.json','package-lock.json']){
 const current=cmd('docker',['exec',runtime.appContainer,'cat','/app/'+file]);const expected=cmd('git',['-C',source,'show',runtime.commit+':'+file]);assert.equal(current,expected,file+' runtime source mismatch');runtime.sourceHashes[file]=createHash('sha256').update(current).digest('hex');
}
let cookie;
async function http(method,path,body,auth=cookie){const r=await fetch(runtime.base+path,{method,headers:{...(auth?{Cookie:auth}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const out=await r.json();assert(r.ok,'Setup '+method+' '+path+' returned '+r.status);return{body:out,cookie:r.headers.getSetCookie().map(x=>x.split(';',1)[0]).join('; ')};}
const humanPassword=randomBytes(24).toString('base64url'),agentPassword=randomBytes(24).toString('base64url');
const admin=await http('POST','/api/auth/setup',{email:'reviewer@example.com',name:'Browser Reviewer',password:humanPassword});cookie=admin.cookie;
const user=await http('POST','/api/users',{email:'agent@example.com',name:'API Agent',password:agentPassword});
const space=(await http('POST','/api/spaces',{name:'Document edit lab'})).body;
await http('PUT','/api/spaces/'+space.slug+'/members/'+user.body.id,{role:'editor'});
const agent=await http('POST','/api/auth/login',{email:'agent@example.com',password:agentPassword});
const token=(await http('POST','/api/me/tokens',{name:'Disposable two-passage evidence',scopes:['read','write']},agent.cookie)).body.token;
const require=createRequire(source+'/package.json');
const {Client}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
const {StreamableHTTPClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')));
const client=new Client({name:'two-passage-fixture',version:'1.0.0'});await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',runtime.base),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
const title='Two passages',markdown='# '+title+'\n\nFirst: old.\n\nMiddle: original.\n\nLast: old.\n';
const result=await client.callTool({name:'create_page',arguments:{space:space.slug,parentPath:'',title,markdown}});assert(!result.isError,'MCP create_page failed');const meta=result.structuredContent??JSON.parse(result.content.find(x=>x.type==='text').text);assert(meta.id);await client.close();
const fixture={auth:{email:'reviewer@example.com',password:humanPassword,token},space:space.slug,pages:{twoEdits:{id:meta.id,path:meta.path,title,markdown}}};
writeFileSync(root+'/fixture.private.json',JSON.stringify(fixture,null,2)+'\n',{mode:0o600});
writeFileSync(root+'/runtime.json',JSON.stringify(runtime,null,2)+'\n');
console.log('Public REST setup and real MCP create_page succeeded; runtime matches '+runtime.commit);
