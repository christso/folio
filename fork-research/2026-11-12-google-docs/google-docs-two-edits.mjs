// Bounded Yjs behavior probe; this does not run Folio REST/MCP or Google Docs.
// Usage: node fork-research/2026-11-12-google-docs/google-docs-two-edits.mjs /path/to/folio-with-node_modules
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
const require = createRequire(resolve(root, 'package.json'));
const Y = require('yjs');
const ts = require('typescript');
const fixedCommit = 'c5545fdfed40cf421bd44dc8716d71c3cd8b2f21';
const source = execFileSync('git', ['show', `${fixedCommit}:server/collab.ts`], { cwd: root, encoding: 'utf8' });
const ast = ts.createSourceFile('collab.ts', source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'setYText');
assert.ok(declaration, 'Pinned PR14 helper must exist');
const javascript = ts.transpileModule(declaration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const setYText = new Function('Y', `${javascript}\nreturn setYText;`)(Y);
const marker = 'Browser note: keep this sentence.\n\n';
const initial = '# Example\n\nFirst: old.\n\nMiddle paragraph.\n\nLast: old.\n\nTail paragraph.\n';

function probe(mode, position) {
  const doc = new Y.Doc();
  const text = doc.getText('content');
  text.insert(0, initial);
  const browserOrigin = {};
  const undo = new Y.UndoManager(text, { trackedOrigins: new Set([browserOrigin]) });
  const at = initial.indexOf(position === 'between' ? 'Middle paragraph.' : 'Tail paragraph.');
  doc.transact(() => text.insert(at, marker), browserOrigin);
  undo.stopCapturing();
  const before = text.toString();
  const expected = before.replace('First: old.', 'First: new.').replace('Last: old.', 'Last: new.');
  const deltas = [];
  text.observe(event => deltas.push(event.delta));
  doc.transact(() => {
    if (mode === 'pr14-single-splice') {
      setYText(text, expected);
    } else {
      // Equivalent Yjs mutations to the fork's validated descending range loop.
      // Validation, access, persistence and transport are outside this probe.
      const changes = ['First: old.', 'Last: old.'].map(value => {
        const from = before.indexOf(value) + value.indexOf('old');
        return { from, to: from + 3, text: 'new' };
      });
      for (const edit of changes.reverse()) {
        text.delete(edit.from, edit.to - edit.from);
        text.insert(edit.from, edit.text);
      }
    }
  }, 'api');
  assert.equal(text.toString(), expected, 'Both requested edits must apply');
  const apiDelta = deltas[0];
  undo.undo();
  const afterUndo = text.toString();
  const browserUndoWorks = !afterUndo.includes(marker);
  assert.ok(afterUndo.includes('First: new.') && afterUndo.includes('Last: new.'), 'Agent edits must survive');
  assert.equal(browserUndoWorks, mode !== 'pr14-single-splice' || position !== 'between');
  undo.redo();
  assert.equal(text.toString(), expected, 'Redo returns to post-API body');
  undo.destroy();
  doc.destroy();
  return { mode, browserInsertion: position, browserUndoWorks, agentEditsSurviveUndo: true, apiDelta, afterUndo };
}

console.log(JSON.stringify({
  fixedCommit,
  yjsVersion: require('yjs/package.json').version,
  scope: 'Pinned production setYText helper executed with real Yjs. Explicit-range case models fork mutations. No server, browser, Google Docs two-location, persistence or authorization test is claimed.',
  cases: ['pr14-single-splice', 'explicit-two-ranges'].flatMap(mode => ['between', 'after'].map(position => probe(mode, position))),
}, null, 2));
