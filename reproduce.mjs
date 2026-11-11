import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2];
assert(['before', 'after'].includes(mode), 'usage: node reproduce.mjs before|after');
const source = process.env.FOLIO_SOURCE;
const container = process.env.FOLIO_EVIDENCE_CONTAINER;
const base = new URL(process.env.FOLIO_EVIDENCE_URL);
const database = new URL(process.env.DATABASE_URL);
assert(source && container?.startsWith('folio-proposal-'), 'use an isolated folio-proposal-* container');
assert(['127.0.0.1', 'localhost'].includes(base.hostname), 'browser target must be loopback');
assert(['127.0.0.1', 'localhost'].includes(database.hostname), 'database target must be loopback');
const baseline = '94f4e0a6e9f83bd84f80ae097e47910242b7bd99';
const fixed = 'd8d0db83d947b7eb6d0ab4e6d3f29a99ce045b82';
const output = path.join(here, mode);
mkdirSync(output, { recursive: true });
const require = createRequire(path.join(source, 'package.json'));
const { Pool } = require('pg');
const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
const { StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function run(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(binary + ' failed: ' + result.stderr.slice(-1600));
  return result.stdout;
}
const session = 'folio-proposal-evidence-' + mode;
function browser(...args) {
  const result = JSON.parse(run('agent-browser', ['--json', '--session', session, ...args]));
  if (!result.success) throw new Error('browser: ' + JSON.stringify(result.error));
  return result.data;
}
function evaluate(code) { return browser('eval', code).result; }
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(100); }
  throw new Error('Timed out: ' + label);
}
await until(async () => { try { return (await fetch(new URL('/api/health', base))).ok; } catch { return false; } }, 'disposable server startup');
run('docker', ['cp', path.join(here, 'seed.mjs'), container + ':/app/evidence-seed.mjs']);
const seeded = run('docker', ['exec', container, './node_modules/.bin/tsx', '/app/evidence-seed.mjs']);
const fixture = JSON.parse(seeded.trim().split('\n').at(-1));
const client = new Client({ name: 'proposal-acceptance-evidence', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), { requestInit: { headers: { Authorization: 'Bearer ' + fixture.token } } }));
async function mcp(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert(!result.isError, 'MCP tool failed: ' + name);
  return result.structuredContent ?? JSON.parse(result.content.find((c) => c.type === 'text').text);
}
const initial = await mcp('read_page', { id: fixture.pageId });
assert.equal(initial.markdown, fixture.markdown);
assert.equal(typeof initial.bodyRevision, 'string');
const proposedMarkdown = fixture.markdown.replace('Status: draft.', 'Status: reviewed.');
const proposal = await mcp('update_page', { id: fixture.pageId, markdown: proposedMarkdown, baseRevision: initial.bodyRevision });
assert.equal(proposal.status, 'proposed');
assert.equal((await mcp('read_page', { id: fixture.pageId })).markdown, fixture.markdown);
console.log(mode + ': revision-checked MCP proposal created; original page unchanged');
browser('open', base.href);
browser('set', 'viewport', '1280', '720');
browser('wait', 'input[type=email]');
browser('fill', 'input[type=email]', 'reviewer@example.com');
browser('fill', 'input[type=password]', 'synthetic-evidence-password');
browser('click', 'button[type=submit]');
await until(() => evaluate('!document.querySelector("input[type=password]")'), 'login');
const pageUrl = new URL('/s/' + fixture.space + '/p/' + fixture.pageId, base).href;
browser('open', pageUrl);
await until(() => evaluate('Array.from(document.querySelectorAll("button")).some(x=>x.textContent.trim()==="Source")'), 'editor');
const origin = performance.now();
const captions = [{ at: 0, text: mode.toUpperCase() + ': ' + (mode === 'before' ? 'clean upstream ' + baseline.slice(0, 12) : 'same baseline + focused patch ' + fixed.slice(0, 12)) + '\nReal browser + HTTP MCP/REST; synthetic page only.' }];
const caption = (text) => captions.push({ at: (performance.now() - origin) / 1000, text });
browser('record', 'start', path.join(output, 'capture.webm'), pageUrl);
await until(() => evaluate('Array.from(document.querySelectorAll("button")).some(x=>x.textContent.trim()==="Source")'), 'recorded editor');
evaluate('Array.from(document.querySelectorAll("button")).find(x=>x.textContent.trim()==="Source").click()');
browser('wait', '.cm-content[contenteditable=true]');
await sleep(3500);
const detail = evaluate('(async()=>await(await fetch(' + JSON.stringify('/api/proposals/' + proposal.proposalId) + ')).json())()');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const blocker = await pool.connect();
let locked = false;
let recording = true;
let receipt;
try {
  await blocker.query('BEGIN'); locked = true;
  await blocker.query('SELECT id FROM page_proposals WHERE id = $1 FOR UPDATE', [proposal.proposalId]);
  const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  evaluate('window.__evidenceAcceptance={pending:true};fetch(' + JSON.stringify('/api/proposals/' + proposal.proposalId + '/decision') + ',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(' + JSON.stringify({ decision: 'accept', currentHash: detail.currentHash }) + ')}).then(async r=>window.__evidenceAcceptance={status:r.status,body:await r.json()});true');
  await until(async () => (await pool.query('SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked', [pid])).rows[0].blocked, 'real acceptance query blocked by row lock');
  caption('Automated REST acceptance is waiting.\nA test-held PostgreSQL row lock makes this ordering repeatable.');
  await sleep(2500);
  const marker = 'Browser addition: keep this sentence.';
  browser('click', '.cm-content[contenteditable=true]');
  browser('press', 'Control+End');
  browser('press', 'Enter');
  browser('keyboard', 'type', marker);
  browser('press', 'Enter');
  const newer = await until(async () => { const page = await mcp('read_page', { id: fixture.pageId }); return page.markdown.includes(marker) ? page : false; }, 'browser addition confirmed by HTTP MCP');
  caption('New sentence typed with browser keyboard input.\nHTTP MCP read_page confirms it on the server before acceptance resumes.');
  await sleep(3500);
  await blocker.query('COMMIT'); locked = false;
  const acceptance = await until(() => { const r = evaluate('window.__evidenceAcceptance'); return r?.status ? r : false; }, 'acceptance response');
  assert.equal(acceptance.status, mode === 'before' ? 200 : 409);
  if (mode === 'after') assert.equal(acceptance.body.code, 'revision_conflict');
  const final = await until(async () => {
    const page = await mcp('read_page', { id: fixture.pageId });
    const retained = page.markdown.includes(marker);
    return retained === (mode === 'after') && page.markdown.includes(mode === 'before' ? 'Status: reviewed.' : 'Status: draft.') ? page : false;
  }, 'observed final body');
  caption(mode === 'before' ? 'BEFORE: acceptance returned HTTP 200.\nThe newer browser sentence has disappeared.' : 'AFTER: acceptance returned HTTP 409 revision_conflict.\nThe newer browser sentence is preserved; the proposal stays pending.');
  await sleep(4000);
  browser('reload');
  await until(() => evaluate('Array.from(document.querySelectorAll("button")).some(x=>x.textContent.trim()==="Source")'), 'reload');
  evaluate('Array.from(document.querySelectorAll("button")).find(x=>x.textContent.trim()==="Source").click()');
  browser('wait', '.cm-content[contenteditable=true]');
  const reloaded = await mcp('read_page', { id: fixture.pageId });
  const rest = evaluate('(async()=>await(await fetch(' + JSON.stringify('/api/pages/' + fixture.pageId) + ')).json())()');
  assert.equal(rest.markdown, reloaded.markdown);
  assert.equal(reloaded.markdown.includes(marker), mode === 'after');
  const rendered = evaluate('document.querySelector(".cm-content").innerText');
  assert.equal(rendered.includes(marker), mode === 'after');
  const file = await until(() => {
    const text = run('docker', ['exec', container, 'cat', '/app/data/repos/' + fixture.space + '/' + fixture.path]);
    return text.includes(marker) === (mode === 'after') && text.includes(mode === 'before' ? 'Status: reviewed.' : 'Status: draft.') ? text : false;
  }, 'current Markdown file');
  const stored = (await pool.query('SELECT status FROM page_proposals WHERE id = $1', [proposal.proposalId])).rows[0].status;
  assert.equal(stored, mode === 'before' ? 'accepted' : 'pending');
  caption(mode === 'before' ? 'Reload + REST/MCP + current Markdown file agree:\nnew browser sentence lost; proposal marked accepted.' : 'Reload + REST/MCP + current Markdown file agree:\nnew browser sentence retained; proposal remains pending for review.');
  await sleep(4500);
  browser('screenshot', path.join(output, 'final.png'));
  browser('record', 'stop'); recording = false;
  receipt = {
    mode, baselineCommit: baseline, fixedCommit: mode === 'after' ? fixed : null,
    syntheticOnly: true, realHttpMcp: true, proposalSubmittedWithBaseRevision: true,
    injectedScheduling: 'PostgreSQL SELECT FOR UPDATE holds the proposal claim; no application function is mocked or patched for capture',
    browserSentenceConfirmedBeforeRelease: newer.markdown.includes(marker),
    acceptanceStatus: acceptance.status, acceptanceCode: acceptance.body.code ?? null,
    proposalStoredStatus: stored, browserSentenceAfterReload: rendered.includes(marker),
    mcpMarkdown: reloaded.markdown, restMarkdown: rest.markdown,
    fileContainsBrowserSentence: file.includes(marker), fileSha256: createHash('sha256').update(file).digest('hex'),
    finalBodySha256: createHash('sha256').update(final.markdown).digest('hex'), assertionsPassed: true,
  };
} finally {
  if (locked) await blocker.query('ROLLBACK');
  blocker.release(); await pool.end(); await client.close();
  if (recording) { try { browser('record', 'stop'); } catch {} }
  browser('close');
}
function stamp(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return String(Math.floor(ms / 3600000)).padStart(2, '0') + ':' + String(Math.floor(ms / 60000) % 60).padStart(2, '0') + ':' + String(Math.floor(ms / 1000) % 60).padStart(2, '0') + ',' + String(ms % 1000).padStart(3, '0');
}
const duration = Number(JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', path.join(output, 'capture.webm')])).format.duration);
const srt = captions.map((c, i) => (i + 1) + '\n' + stamp(c.at) + ' --> ' + stamp(captions[i + 1]?.at ?? duration) + '\n' + c.text + '\n').join('\n');
writeFileSync(path.join(output, 'captions.srt'), srt);
const filter = 'pad=1280:830:0:0:color=white,drawbox=x=0:y=720:w=1280:h=110:color=0x111827:t=fill,subtitles=' + path.join(output, 'captions.srt') + ":force_style='FontName=DejaVu Sans,FontSize=8,PrimaryColour=&HFFFFFF,Outline=0,Alignment=2,MarginV=7'";
const video = path.join(here, mode + '.mp4');
run('ffmpeg', ['-y', '-i', path.join(output, 'capture.webm'), '-vf', filter, '-r', '20', '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video]);
run('ffmpeg', ['-v', 'error', '-i', video, '-f', 'null', '-']);
receipt.video = { file: mode + '.mp4', bytes: statSync(video).size, sha256: createHash('sha256').update(readFileSync(video)).digest('hex'), durationSeconds: duration };
writeFileSync(path.join(here, mode + '-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ mode, acceptanceStatus: receipt.acceptanceStatus, retainedAfterReload: receipt.browserSentenceAfterReload, video: receipt.video, assertionsPassed: true }));
