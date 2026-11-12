import { randomBytes } from 'node:crypto';
import { hash } from '/app/node_modules/bcryptjs/index.js';
import { createUser, setMembership, createApiToken } from '/app/server/auth/store.ts';
import { createSpace, createPage } from '/app/server/storage.ts';
import { setAgentWriteMode } from '/app/server/proposals.ts';
import { closePool } from '/app/server/db/pool.ts';
import { closeRedis } from '/app/server/db/redis.ts';

const password=randomBytes(24).toString('base64url');
const reviewer=await createUser({email:'reviewer@example.com',name:'Reviewer',passwordHash:await hash(password,10),isAdmin:true});
const agent=await createUser({email:'agent@example.com',name:'Agent',passwordHash:'!',isAdmin:false});
const recovery=await createSpace('Recovery audit',null);
const review=await createSpace('Proposal review example',null);
for(const space of [recovery,review]) {
  await setMembership(space.slug,reviewer.id,'admin');
  await setMembership(space.slug,agent.id,'editor');
}
await setAgentWriteMode(recovery.slug,'direct');
await setAgentWriteMode(review.slug,'review');
const pages={};
for(const [key,title,marker] of [
 ['snapshotControl','Snapshot control','BASELINE-CONTROL-SENTINEL'],
 ['snapshotFault','Snapshot recovery','BASELINE-RECOVERY-SENTINEL'],
 ['saveFault','Save recovery','BASELINE-SAVE-SENTINEL'],
]) {
 const markdown=`# ${title}\n\n${marker}\n\nOriginal paragraph stays.\n`;
 const page=await createPage({space:recovery.slug,parentPath:'',title,kind:'doc'},{docBody:markdown});
 pages[key]={...page,markdown,marker};
}
const token=await createApiToken(agent.id,'Disposable recovery evidence',['read','write']);
// Captured directly into protected private runtime storage; never evidence output.
console.log(JSON.stringify({auth:{email:reviewer.email,password,token:token.token},recoverySpace:recovery.slug,reviewSpace:review.slug,pages}));
await closeRedis();await closePool();process.exit(0);
