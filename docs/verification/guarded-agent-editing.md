# Guarded agent editing: local verification

Verified on 7 November 2026, from feature branch `feat/guarded-agent-editing` based on deployment commit `2d2ae63b351b88375616f25a6a1a12bc8dde5638`.
That baseline has the same source tree as `e4de9bac7748c30c77129ab367a06291748bd3b3`.
The deployment checkout was left clean and unchanged; the existing conflict-state implementation was not modified.

Plan: [Guarded shared document editing](../plans/2026-11-07-guarded-agent-editing-plan.md).
Contract and integration boundary: [Shared agent editing](../AGENT-EDITING.md).

## Final checks

| Check | Result |
|---|---|
| `npm run typecheck` | Passed, exit 0 |
| Targeted Vitest run below | 10 files, 164 tests passed; 87.41 seconds |
| `npm run build` | Passed; Vite build 2.72 seconds; existing large-chunk warning remains |
| `git diff --check` | Passed |
| Dockerfile build | Passed, including the existing keyless native SDK check and production dependency install on Node 22 Alpine |
| Built-container source comparison | All eight changed production modules matched their local SHA-256 hashes |
| Real Chrome against the built container | Passed: browser typing, stale replacement 409, exact bot edit 200, unrelated text, reload, desktop and mobile screenshots |
| Local Git persistence and attribution | Disposable page reached a `folio:update` commit under `Example Owner <owner@example.com>`; clean local working tree after the quiet period |

```sh
npx vitest run server/documentEdits.test.ts server/documentEditing.test.ts \
  server/collab.test.ts server/mcp.test.ts server/contentSafety.test.ts \
  server/shareCollab.test.ts server/pageAccessInherit.test.ts \
  server/assistant/toolAccess.test.ts server/gitMerge.test.ts server/gitNative.test.ts
```

Tests used disposable PostgreSQL schemas, Redis, real files, real Yjs documents, MCP SDK transport and collaboration sockets.
Browser validation used a separate disposable database and synthetic pages, with no remote Git binding.
The local image was `folio-guarded-agent-editing:local`, image identifier `sha256:c42d151c4812f9308b20259e41067057f51bb06cbade570ec61284d9c5b620f8`.
The review fixture listens only on `127.0.0.1:54870`; it is not a deployment.
Local browser scripts, screenshots and JSON evidence are retained as untracked artifacts under `.qa/guarded-agent-editing/`.
An optional local commit was attempted but Git rejected it because no author identity is configured.
No identity was invented and Git configuration was not changed; the 27 application/documentation paths remain staged for review.

The runtime comparison covered `server/collab.ts`, `server/documentEdits.ts`, `server/mcp.ts`, `server/mcpOutputSchemas.ts`, `server/routes.ts`, `server/pageDoc.ts`, `server/assistant/tools.ts` and `shared/contracts.ts`.

## Evidence and review

The first pure regression failed because the guarded primitive did not exist; the first integration regression failed because reads did not return a revision.
The assistant truncation regression failed on its previous apparent-success result before the bounded failure was implemented.
Final regressions cover competing writers; typing during awaited preparation; offline edits outside a replacement; exact ranges and Unicode boundaries; frontmatter; cold snapshot/final-newline reads; snapshot lookup and decode failure; file and snapshot persistence failures; retry exhaustion/recovery and room reclamation; legacy cold-readiness; scopes, private and ancestor-restricted pages; no-op attribution; complete large external MCP reads; assistant truncation; and socket close/reopen during an awaited save.

The first container startup failed because a schema-isolated test database had its extension in a temporary schema.
Using a separate disposable browser database resolved that prerequisite; the final container and browser runs passed.
Recovery-test timing was corrected to account for the existing 800 ms debounce on each retry; the final test proves exhaustion, recovery and eviction instead of stopping at the first failed write.
The suite still prints existing dual-Yjs and Node localStorage warnings.

Compound Engineering planning ran in pipeline mode and implementation used its local-verification-only path.
Plan review resolved two omissions: cold reads must use restored state, and snapshot acquisition must fail closed.
Simplification applied three small cleanups without removing guards or proof tests.
Code review used native reviewers for correctness, standards, testing, maintainability, agent access, security, API compatibility, reliability, adversarial analysis and resource behavior.
Material findings were addressed: legacy writers await/pin restored rooms; actual file writes schedule commits even if snapshot persistence fails; incomplete assistant reads withhold revisions; the Unicode boundary proof reaches the intended guard; and failed API rooms can recover and be reclaimed after normal retries end.
No cross-provider review ran and no model/provider settings were changed.
The completed review reported no remaining findings after all five distinct code-review issues were resolved.
The final host build gate also passed; review readiness does not authorize a merge or release.

## Limits and remaining work

This is a local implementation, with no live bot migration, deployment, remote publication, index refresh, production permission change or credential change.
Remote Git publication and downstream indexing were not exercised.
The full test suite was not run; the targeted release gates above passed.
Owner behavior approval remains required before any separately authorized rollout.

This is a single-document API with content preconditions, not durable request-id journaling, an atomic multi-page publisher or an approval queue.
Legacy cookie body replacements and internal writers remain unguarded replacements.
The existing one-process Yjs deployment model remains.
The built-in assistant retains its existing response budget; oversized document reads fail explicitly with a read-only preview, while external MCP/REST can edit complete bodies within the 1 MiB limit.
Published Git readers and indexes, private scope boundaries, source exclusions, original-source policy and structured note-save journals/receipts/approvals remain on their existing paths.
Before switching a caller, separately approve its destination/publication policy, test its allowlisted adapter and verify the published branch and intended index.

## Changed paths

Application contract and implementation:

- `shared/contracts.ts`
- `server/documentEdits.ts`
- `server/collab.ts`
- `server/pageDoc.ts`
- `server/routes.ts`
- `server/mcp.ts`
- `server/mcpOutputSchemas.ts`
- `server/assistant/tools.ts`

Tests:

- `server/documentEdits.test.ts`
- `server/documentEditing.test.ts`
- `server/mcp.test.ts`
- `server/assistant/toolAccess.test.ts`

Public and agent guidance:

- `CHANGELOG.md`
- `DEV-PLAN.md`
- `README.md`
- `docs/AGENT-EDITING.md`
- `docs/FEATURES.md`
- `docs/HANDOFF.md`
- `docs/LIMITATIONS.md`
- `docs/MCP.md`
- `docs/plans/2026-11-07-guarded-agent-editing-plan.md`
- `docs/verification/guarded-agent-editing.md`
- `server/assistant/prompts/folio-context.md`
- `server/assistant/skills/folio-mcp/SKILL.md`
- `integrations/claude-code/skills/folio-wiki/SKILL.md`
- `integrations/codex-plugin/skills/folio-wiki/SKILL.md`
- `integrations/cursor-plugin/skills/folio-wiki/SKILL.md`
