import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {root,runtime,fixture,authenticate,http,httpTrace,mcpConnection} from './harness.mjs';
await authenticate();const client=await mcpConnection();
try{
 const page=fixture.pages.pathMove;const before=await client.call('read_page',{id:page.id});
 const rename=await http('POST','/api/pages/'+page.id+'/slug',{slug:'path-move-renamed'});assert.equal(rename.status,200);
 const after=(await http('GET','/api/pages/'+page.id,undefined,{agent:true})).body;
 assert.notEqual(after.path,page.path);assert.equal(after.markdown,before.markdown);assert.equal(after.bodyRevision,before.bodyRevision);
 const oldPath=await http('GET','/api/resolve?'+new URLSearchParams({space:fixture.space,path:page.path}),undefined,{agent:true});assert.equal(oldPath.status,404);
 const write=await http('PUT','/api/pages/'+page.id,{markdown:before.markdown.replace('Status: draft.','Status: pending-agent-edit.'),baseRevision:before.bodyRevision},{agent:true});assert.equal(write.status,200);
 // This is normal upstream page-ID behavior, not reported as an upstream defect.
 const movedBody=(await http('GET','/api/pages/'+page.id,undefined,{agent:true})).body;assert(movedBody.markdown.includes('pending-agent-edit'));
 const access=fixture.pages.adapter;const accessRead=await client.call('read_page',{id:access.id});
 const revoke=await http('PUT','/api/spaces/'+fixture.space+'/members/'+fixture.agent.id,{role:'viewer'});assert.equal(revoke.status,200);
 let refused;try{
  refused=await http('PUT','/api/pages/'+access.id,{markdown:accessRead.markdown+'\nShould not be written.\n',baseRevision:accessRead.bodyRevision},{agent:true});assert.equal(refused.status,403);
 }finally{const restore=await http('PUT','/api/spaces/'+fixture.space+'/members/'+fixture.agent.id,{role:'editor'});assert.equal(restore.status,200);}
 const retained=await client.call('read_page',{id:access.id});assert.equal(retained.markdown,accessRead.markdown);
 const receipt={case:'contracts',baseline:runtime.baseline,fixedCommit:runtime.fixedCommit,noFaultInjection:true,ordinaryActionsOnly:true,rename:{oldPath:page.path,newPath:after.path,bodyRevisionUnchanged:true,oldPathResolveStatus:oldPath.status,pendingWriteByIdStatus:write.status,behavior:'Upstream bodyRevision guards content, not location. A native client can notice a completed move by resolving again; this is not the fork atomic location precondition.'},revokedWriteRole:{status:refused.status,noMutation:true,roleRestored:true},httpTrace};
 writeFileSync(root+'/contract-checks.json',JSON.stringify(receipt,null,2)+'\n');console.log('Normal rename: body revision unchanged, pending page-ID edit follows moved page. Ordinary permission revoke: write refused 403 without changes.');
}finally{await client.close();}
