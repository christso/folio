import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.dirname(fileURLToPath(import.meta.url));const runtime=JSON.parse(readFileSync(root+'/runtime.json'));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const command=(bin,args,cwd)=>{const r=spawnSync(bin,args,{cwd,encoding:'utf8',timeout:60000});if(r.status!==0){writeFileSync(root+'/setup-failure.private.log',r.stdout+'\n'+r.stderr,{mode:0o600});throw Error('Setup command failed: '+bin);}return r.stdout;};
for(let i=0;i<150;i++){try{if((await fetch(runtime.base+'/api/health')).ok&&(await fetch(runtime.gitHost.replace('/shared.git','/health'))).ok)break;}catch{}if(i===149)throw Error('Fixture services not healthy');await pause(200);}
// Verify untouched runtime is the exact upstream-plus-PR14 commit.
const source=process.env.FOLIO_SOURCE;assert(source);
runtime.sourceHashes={};for(const file of ['server/collab.ts','server/gitSync.ts','server/mcp.ts','server/routes.ts','shared/contracts.ts','package-lock.json']){
 const current=command('docker',['exec',runtime.appContainer,'cat','/app/'+file]);const expected=command('git',['-C',source,'show',runtime.fixedCommit+':'+file]);assert.equal(current,expected,file);
 runtime.sourceHashes[file]=createHash('sha256').update(current).digest('hex');
}
command('docker',['exec',runtime.gitContainer,'git','init','--bare','-b','main','/repos/shared.git']);
command('docker',['exec',runtime.gitContainer,'git','--git-dir=/repos/shared.git','config','http.receivepack','true']);
const repo=root+'/agent-git';if(!existsSync(repo+'/.git'))command('git',['clone',runtime.gitHost,repo]);
const pages={};
for(const [key,title] of [['apiUndo','API Undo'],['restUndo','REST Undo'],['twoEdits','Two edits'],['gitUndo','Git Undo'],['threeWriters','Three writers'],['twoBrowsers','Two browsers'],['gitConflict','Git conflict'],['adapter','Adapter compatibility'],['pathMove','Path move'],['review','Review flow']]){
 const rel=key.replace(/[A-Z]/g,x=>'-'+x.toLowerCase())+'.md';
 const markdown='# '+title+'\n\nFirst: old.\n\nStatus: draft.\n\nMiddle: original.\n\nMCP field: original.\n\nGit field: original.\n\nLast: old.\n';
 writeFileSync(repo+'/'+rel,markdown);pages[key]={path:rel,markdown,title};
}
writeFileSync(repo+'/index.md','# Collaboration lab\n\nSynthetic browser, REST, MCP and Git testing.\n');
const git=(...args)=>command('git',['-c','user.name=Git Agent','-c','user.email=git-agent@example.com',...args],repo);
git('branch','-M','main');git('add','.');if(git('status','--porcelain').trim())git('commit','-m','Seed synthetic collaboration examples');git('push','origin','main');
const passwords={human:randomBytes(24).toString('base64url'),agent:randomBytes(24).toString('base64url')};
let cookie;
const http=async(method,p,body,auth=cookie)=>{
 const r=await fetch(runtime.base+p,{method,headers:{...(auth?{Cookie:auth}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const out=await r.json();assert(r.ok,'Setup HTTP '+method+' '+p+' failed '+r.status);
 return {body:out,cookie:r.headers.getSetCookie().map(x=>x.split(';',1)[0]).join('; ')};
};
const admin=await http('POST','/api/auth/setup',{email:'reviewer@example.com',name:'Browser Reviewer',password:passwords.human});cookie=admin.cookie;
const user=await http('POST','/api/users',{email:'agent@example.com',name:'API Agent',password:passwords.agent});
const space=(await http('POST','/api/spaces',{name:'Collaboration lab',repoUrl:runtime.gitApp,branch:'main',rootPath:'',lightFootprint:true})).body;
await http('PUT','/api/spaces/'+space.slug+'/members/'+user.body.id,{role:'editor'});
const agent=await http('POST','/api/auth/login',{email:'agent@example.com',password:passwords.agent});
const token=(await http('POST','/api/me/tokens',{name:'Disposable upstream workflow test',scopes:['read','write']},agent.cookie)).body;
const flatten=nodes=>nodes.flatMap(n=>[n,...flatten(n.children??[])]);
let nodes;for(let i=0;i<100;i++){nodes=flatten((await http('GET','/api/spaces/'+space.slug+'/tree')).body.tree);if(Object.values(pages).every(p=>nodes.some(n=>n.path===p.path)))break;await pause(100);}
for(const page of Object.values(pages)){const node=nodes.find(n=>n.path===page.path);assert(node,'Imported page missing '+page.path);page.id=node.id;}
const fixture={auth:{email:'reviewer@example.com',password:passwords.human,token:token.token},agent:{email:'agent@example.com',password:passwords.agent,id:user.body.id},space:space.slug,pages};
writeFileSync(root+'/fixture.private.json',JSON.stringify(fixture,null,2)+'\n',{mode:0o600});
writeFileSync(root+'/runtime.json',JSON.stringify(runtime,null,2)+'\n');
console.log('Synthetic Git remote imported via real HTTP; browser account and agent PAT created via public REST. Runtime matches '+runtime.fixedCommit+'.');
