import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {root,fixture,mcpConnection} from './harness.mjs';
const client=await mcpConnection();
for(const [key,title] of [['gitUndoFinalNewline','Git Undo newline control'],['twoEditsSequential','Two edits sequential control'],['quoteCompatibility','Quote compatibility']]){
 const markdown='# '+title+'\n\nFirst: old.\n\nStatus: draft.\n\nMiddle: original.\n\nMCP field: original.\n\nGit field: original.\n\nLast: old.\n';
 const p=await client.call('create_page',{space:fixture.space,parentPath:'',title,markdown});assert(p.id&&p.path);
 fixture.pages[key]={id:p.id,path:p.path,title,markdown};
}
writeFileSync(root+'/fixture.private.json',JSON.stringify(fixture,null,2)+'\n',{mode:0o600});await client.close();console.log('Added three synthetic controls through native HTTP MCP create_page.');
