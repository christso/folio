// Run only against a disposable page containing the exact example below.
// Requires the Folio repository's @modelcontextprotocol/sdk dependency.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const seed = '# Concurrent editing example\n\nStatus: draft.\n\nOriginal paragraph stays.\n';
const marker = 'Browser addition: keep this sentence.';
const id = process.env.FOLIO_PAGE_ID;
assert.ok(id && process.env.FOLIO_TOKEN_FILE, 'Set FOLIO_PAGE_ID and FOLIO_TOKEN_FILE.');
const token = readFileSync(process.env.FOLIO_TOKEN_FILE, 'utf8').trim();
const client = new Client({ name: 'disposable-lost-update-reproducer', version: '1' });
const prompt = createInterface({ input: stdin, output: stdout });
function data(result) {
  if (result.structuredContent) return result.structuredContent;
  return JSON.parse(result.content.find(item => item.type === 'text').text);
}
try {
  await client.connect(new StreamableHTTPClientTransport(
    new URL('/mcp', process.env.FOLIO_URL || 'http://localhost:4870'),
    { requestInit: { headers: { Authorization: 'Bearer ' + token } } },
  ));
  const original = data(await client.callTool({ name: 'read_page', arguments: { id } }));
  assert.equal(original.markdown.trim(), seed.trim(), 'Use a disposable page with the exact example body.');
  await prompt.question('In the browser, append "' + marker + '". Leave the page open, then press Enter here. ');
  const current = data(await client.callTool({ name: 'read_page', arguments: { id } }));
  assert.ok(current.markdown.includes(marker), 'Wait for the browser addition to reach the server.');
  const args = { id, markdown: original.markdown.replace('Status: draft.', 'Status: reviewed.') };
  if (original.revision) args.expectedRevision = original.revision;
  const update = await client.callTool({ name: 'update_page', arguments: args });
  const after = data(await client.callTool({ name: 'read_page', arguments: { id } }));
  console.log(JSON.stringify({
    staleUpdateRejected: !!update.isError,
    browserSentencePreserved: after.markdown.includes(marker),
    statusChanged: after.markdown.includes('Status: reviewed.'),
  }, null, 2));
  console.log('Reload the browser page and check whether the appended sentence remains.');
} finally {
  prompt.close();
  await client.close();
}
