import { hash } from '/app/node_modules/bcryptjs/index.js';
import { createUser, setMembership, createApiToken } from '/app/server/auth/store.ts';
import { createSpace, createPage } from '/app/server/storage.ts';
import { setAgentWriteMode } from '/app/server/proposals.ts';
import { closePool } from '/app/server/db/pool.ts';
import { closeRedis } from '/app/server/db/redis.ts';

const reviewer = await createUser({ email: 'reviewer@example.com', name: 'Reviewer', passwordHash: await hash('synthetic-evidence-password', 10), isAdmin: false });
const agent = await createUser({ email: 'agent@example.com', name: 'Agent', passwordHash: 'not-a-login-password', isAdmin: false });
const space = await createSpace('Proposal acceptance example', null);
await setMembership(space.slug, reviewer.id, 'admin');
await setMembership(space.slug, agent.id, 'editor');
await setAgentWriteMode(space.slug, 'review');
const markdown = '# Shared proposal example\n\nStatus: draft.\n\nOriginal paragraph stays.\n';
const page = await createPage({ space: space.slug, parentPath: '', title: 'Shared proposal example', kind: 'doc' }, { docBody: markdown });
const token = await createApiToken(agent.id, 'disposable evidence', ['read', 'write']);
// The host captures this in memory; the credential is never written to an evidence receipt.
console.log(JSON.stringify({ space: space.slug, pageId: page.id, path: page.path, token: token.token, markdown }));
await closeRedis();
await closePool();
process.exit(0);
