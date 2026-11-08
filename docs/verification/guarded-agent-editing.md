# Guarded agent editing: verification and owner review

Verified on 8 November 2026 on `feat/guarded-agent-editing`. The initial implementation at `68c9901` used deployment `2d2ae63` (the same source tree as `e4de9ba`). Merge `b8b5de6` integrates deployment `971aaf471d3cdb9c9d4ea700070114dff43cb9a6` without rewriting published history. The original checkout remains untouched.

Draft review: [PR #2](https://github.com/christso/folio/pull/2). Plan: [Guarded shared document editing](../plans/2026-11-07-guarded-agent-editing-plan.md). Contract and migration boundary: [Shared agent editing](../AGENT-EDITING.md).

## Delivered behavior

REST and MCP reads return a revision for their exact Markdown body. Strict replacements and offset edits check that revision and all ranges synchronously against the restored live Yjs room before mutation. Stale requests fail without overwriting newer server-received text. Frontmatter, MDX source, unrelated Y.Doc roots, permissions and author attribution retain their existing paths.

The additive `replace_page_text` MCP tool and REST `POST /api/pages/:id/replace-text` express explicit location-independent passage replacement. They replace exactly one unchanged unique quotation in the current body, allowing unrelated typing without a read/write revision gap. Missing, ambiguous or guard-recreating results stop. This does not silently rebase an old offset proposal, prove surrounding semantic continuity or provide exactly-once journaling.

Browser documents distinguish connection, server receipt, exact file/snapshot confirmation and unverified Git publication. `File saved` requires a matching server receipt for both the body and canonical collaborative history. New typing, pure deletions and identical body text with new identities invalidate confirmation. A visible failure survives typing/reconnect until matching success. The banner uses plain wording: “Your latest changes could not be confirmed as saved.” It states that automatic retries are limited, recommends keeping the tab open or exporting a copy, and directs editors to `Retry file save` after storage recovers. Readers receive editor-specific guidance. Offline status overrides a stale socket tooltip.

The built-in Agent-mode assistant uses the actual MCP tool wrapper. Conflicts return a complete authorized reread for reconsideration; two conflicts stop further body writes for that page/run. Unknown outcomes require an explicit complete read, and two uncertain writes stop further writes even if reads interleave. The wrapper neither substitutes revisions nor automatically replays mutations. External clients must implement equivalent task-level recovery. No production bot adapter has been installed or switched.

## Integrated release gates

| Check | Result |
|---|---|
| `npm run typecheck` | Passed, exit 0 |
| Targeted Vitest command below | 22 files, 317 tests passed, 153.61 seconds, exit 0 |
| Final rendered-copy and cleanup checks | 3 files, 57 tests passed, 6.09 seconds, exit 0 |
| `npm run build` | Passed, exit 0; 7.60 seconds, existing large-chunk warning |
| Dockerfile build | Passed on Node 22 Alpine, including production install and native SDK check |
| Running-container source comparison | All 11 changed server/shared modules and all 397 built web artifacts match local SHA-256 hashes |
| `git diff --check` | Passed |

The 57-test affected rerun covers `web/src/editor/index.dom.test.tsx`, `web/src/app/collabFileStatus.test.ts` and `web/src/app/offline/syncEngine.flush.test.ts`. It follows the final banner-copy change. The broader final command was:

```sh
NODE_OPTIONS=--no-experimental-webstorage npx vitest run \
  server/documentEdits.test.ts server/documentEditing.test.ts \
  server/collab.test.ts server/mcp.test.ts server/contentSafety.test.ts \
  server/shareCollab.test.ts server/pageAccessInherit.test.ts \
  server/assistant/toolAccess.test.ts server/gitMerge.test.ts server/gitNative.test.ts \
  server/gitSyncConflicts.test.ts server/comments.test.ts server/mdxPages.test.ts \
  server/writingRules.test.ts web/src/app/collabAck.test.ts \
  web/src/app/collabFileStatus.test.ts web/src/app/collabOffline.test.ts \
  web/src/app/offline/syncEngine.flush.test.ts web/src/app/offline/syncEngine.test.ts \
  web/src/editor/collab.test.tsx web/src/editor/index.dom.test.tsx \
  web/src/editor/collab-sync.dom.test.ts
```

Tests use disposable PostgreSQL schemas, Redis, real files/Yjs documents, MCP SDK transports and collaboration sockets. The browser app uses a separate synthetic database. Node 26 on the development host exposes a `localStorage` global that conflicts with jsdom; disabling experimental web storage resolves that environment mismatch. The runtime uses Node 22 Alpine. The full repository suite was not run. Existing dual-Yjs and build chunk-size warnings remain. Intermediate stopped or failing harness/test runs are retained locally and are not counted as passes.

The final runtime image is `sha256:e4f2c93b4eb8e177b5a81592a395f7ed51b6b12115c2ce9905a48c6e749557da`. It runs the repository Dockerfile against a synthetic private space without a remote Git binding. File persistence and local quiet-period Git behavior are exercised; remote publication and downstream indexing are not.

## Real-browser and supported-caller dogfood

Driver: Compound Engineering `ce-test-browser` in pipeline mode, using the installed `agent-browser` headless Chrome driver. Two independently authenticated sessions represent two synthetic people with editor access. Browser edits use actual keyboard/mouse actions in Folio's Source editor, not injected editor transactions or raw Yjs updates. Older tabs in those profiles can retain additional presence entries; this is not a two-socket-count assertion.

The initial integrated eight-scenario pass covered different/same-paragraph typing, stale reread/reconsideration, selection, undo/redo, offline peer/bot merge, caret stability, dropped REST responses and a file fault. It exposed the save-status and retry gaps addressed by the extension. Four baseline browser scenarios were repeated after the extension; the supported MCP/failure flows below were repeated on the final image.

| Scenario | Observed result and boundary |
|---|---|
| Two people type in different paragraphs while a bot prepares an edit | Both additions converge. A delayed strict write receives 409; an actual complete reread and reconsidered edit preserves both authors. |
| Two people type at different positions in the same paragraph | Prefix and suffix additions survive in both editors/readback. This does not establish semantic coherence for competing prose at one insertion gap. |
| Selection, local undo/redo after a remote edit | Selection remains on the first paragraph when a bot changes the second. Undo/redo affects the person's marker and preserves the bot change. Control+Y worked on this Linux browser; Control+Shift+Z did not redo. |
| Bot insertion before a caret | The next typed suffix remains in the intended paragraph; both editors/readback converge. |
| Strict stale retries during ordinary typing | Eight reads followed by a 400 ms preparation delay all conflicted in the earlier pass. Strict retries still have no fairness guarantee. In the final supported HTTP MCP pass, explicit unique-passage replacement completed while unrelated character-by-character typing was still active, without altering that strict contract. One final sample took 67 ms inside the tool, 399 ms including client startup; this is a completion example, not a latency benchmark. |
| Real HTTP MCP persistence failure | A reversible fault on only the synthetic destination returns `body_persistence_failed`. Both browsers show `File save failed` alongside `Received by server`, and separately say `Git publication not confirmed`. The visible banner explains recovery. Typing continues without hiding the failure. |
| Failure, reconnect and offline navigation | Known failure remains after reconnect. Navigating away and returning offline retains the failed-save text. Restoring storage and clicking the actual Retry control confirms the current merged file in both browsers without replacing/replaying text. |
| Offline status and peer changes | Connection and file cues both report offline. Offline typing merges with a real MCP peer edit on reconnect, without duplication. |
| Lost successful MCP response | A loopback proxy forwards exactly one `tools/call`, then drops its accepted response. The real MCP SDK caller reports an unknown outcome. Explicit replay fails because the quote was consumed; complete reread shows one change. Browser file confirmation remains independent of the caller's missing response. |
| Disconnect/reload | Merged text survives and the browser obtains fresh file confirmation. This is not a complete browser/container restart proof. |
| Mobile saved state | At a 375-pixel viewport the saved cue fits; document scroll width is also 375. |
| Exhausted automatic retries | After nine failed writes the writer logs exhaustion; the attempt count stays unchanged during a further two-second observation. The visible error still says retries are limited and keeps export/keep-tab-open/manual Retry guidance. Restoring storage, then clicking Retry without another edit/reconnect/API write, produces `File saved` in both browsers and one copy of the accepted change. |
| Same-browser two-tab recovery | Tab A edits offline, then leaves the target page. Tab B starts a background flush of that older state. A returns offline and types newer text while B waits for file confirmation. The server is checked to contain the older text but not the newer text. After older-state confirmation and a 17-second bounded wait, A closes. Reopened A renders the newer text; readback then contains it once and file confirmation succeeds. No extra code change was needed for this scenario. |

The exhaustion check uses the same final image with the existing test-only retry-cadence setter in an external synthetic startup wrapper. The retry limit remains eight retries plus the initial failure; cadence is accelerated to 1 ms rather than waiting for normal exponential delays. The isolated app is then restored to its normal startup, with no synthetic fault backups remaining. This does not claim the default wall-clock timing was measured.

The two-tab scenario has exactly two ordinary tabs in one browser profile. Its open-session registry remains tab-local. Existing IndexedDB recovery retained the newer edit in this interleaving; there is no new cross-tab ownership lock and no proof of arbitrary cleanup atomicity. A fully offline top-level navigation failed because the isolated server did not provide an offline app shell. The completed check reopens online only after proving the server lacks the newer marker; recovery is then visible and read back once. Offline in-app navigation is tested separately. Earlier stopped harness attempts are not product failures or passing scenarios.

Browser errors and console entries are inspected after the final supported flows. Expected server errors from the explicit file faults are retained locally. Pure socket tests are separate from these real browser actions. Automated integration tests exercise the actual returned assistant tools over MCP, including conflict budgets, complete/oversize/denied rereads and uncertain outcomes. No paid model run or external production adapter UI was exercised, so model explanation quality, approval dialogs and production adapter recovery remain unverified.

## Evidence and attachment boundary

Sanitized synthetic screenshots, recordings, action logs and results remain under the untracked `.qa/guarded-agent-editing/dogfood/` directory. Runtime/browser state and synthetic tokens are excluded from commits. The installed `gh pr edit --help` has no `--attach` capability, so screenshots cannot be attached through the approved CLI. No alternate host or public object store is used. The public PR carries this report and the attachment limitation; local evidence remains available for owner review.

Relevant evidence directories:

- `save-ux-current/`: final plain-language desktop failure, mobile saved cue and six real supported-MCP/browser UX scenarios.
- `save-ux-exhausted-final/`: stopped retry budget and actual manual recovery.
- `save-ux-cross-tab-complete/`: older background flush, newer unsent edit, close/reopen and final confirmation.
- `save-ux-regression-current/`: two-person typing, same-paragraph edits, selection/undo/redo and offline peer merge.

## Findings, fixes and limits

Correctness regressions found when merging deployment were fixed with targeted proofs: comment anchoring now shares the room lease, persists new relative-position identities before acknowledgement, and refuses acknowledgement on storage failure. Cold writing-rule reads now await restored document text. MDX opacity/frontmatter, auxiliary Y.Doc roots and upstream conflict recovery remain covered. The newer Git conflict implementation is unchanged relative to deployment; the retired fork-only ledger is not restored. Live migration of an unresolved historical ledger was not tested.

The extension fixes three observed end-user gaps: receipt no longer masquerades as file-save success, offline/connection cues agree, and an explicit unique-passage edit can finish during unrelated typing. It also bounds supported assistant conflict/uncertainty loops. Review added failure/missing-capability handling, history checks independent of GC/undo data, auxiliary deletion coverage and a cleanup-time same-tab ownership recheck. The retry-exhaustion copy and visible banner were corrected following owner feedback.

Remaining limits are deliberate: strict prepared edits can starve, a changing intended quote can conflict, and task-level recovery belongs to each external caller. A source quotation restored later by another author permits ABA replay; no durable request journal is claimed. Hashing/receipt unavailability stays unconfirmed. Share sessions retain their existing no-IndexedDB policy. Legacy cookie body PUT/internal replacements remain unguarded. File confirmation is not remote publication. No integrated production bot UI exists here, so its conflict explanation, approvals and publication receipts need adapter-specific validation.

## Review

Planning used `ce-plan` in pipeline mode and implementation used `ce-work` for local verification. Initial simplification and review resolved five findings. Deployment integration review resolved comment durability and cold-read issues. The extension simplification applied three small clarity/reuse changes. Its source review reports no remaining material findings after the latest corrections. Coverage used one fresh correctness context, reused security/reliability context and inline lenses because of harness thread limits; independent agreement and cross-provider coverage are not claimed. Reviewers did not independently rerun the implementing agent's gates. Owner behavior approval remains pending, and the PR remains draft. No model/provider settings changed.

## Owner trial and integration boundary

Use synthetic pages in an isolated instance with two editor users. Read a complete body and revision, type before a strict write to observe the stale refusal, then reread/reconsider. Separately use `replace_page_text` for an unchanged unique passage while typing elsewhere. Check both editors and readback. During a synthetic storage fault, verify that `Received by server` coexists with the visible save failure, then restore storage and choose Retry. The file cue must recover without claiming Git publication. Repeat offline/reconnect and undo/redo.

This branch is reviewable in the same draft PR. No PR merge, deployment, live caller migration, real vault edit, production permission or credential change occurred. Publishing this feature branch is distinct from publishing wiki content. Operational space-route configuration is separate from guarded editing.

Shared published readers/indexes stay on their existing Git branch. Single-page APIs cannot atomically publish a page, index and log; they can partially succeed and auto-publish between calls. Retain the existing multi-file publisher's expected hashes, selected-file staging, durable journals, approval policy and separate note-save/publication/index receipts. A later adapter migration must preserve allowlisted destinations, source protections and privacy scopes, verify the actual published branch/index, and switch callers only with separate authorization.

## Changed paths

The outgoing change is grouped by runtime purpose: server/shared guarded-edit and persistence code; browser status/offline recovery and editor UI/translations; tests beside those changes; public plan/contract/handoff/changelog/verification documentation; and five shipped assistant/plugin guidance files. The PR description records the exact path and line counts against deployment. The Files changed tab is the complete inventory. `.qa` runtime/browser data is excluded.

Complete path inventory against deployment:

- **Documentation**: `CHANGELOG.md`, `DEV-PLAN.md`, `README.md`, `docs/AGENT-EDITING.md`, `docs/FEATURES.md`, `docs/HANDOFF.md`, `docs/LIMITATIONS.md`, `docs/MCP.md`, `docs/plans/2026-11-07-guarded-agent-editing-plan.md`, `docs/verification/guarded-agent-editing.md`.
- **Runtime agent guidance**: `integrations/claude-code/skills/folio-wiki/SKILL.md`, `integrations/codex-plugin/skills/folio-wiki/SKILL.md`, `integrations/cursor-plugin/skills/folio-wiki/SKILL.md`, `server/assistant/prompts/folio-context.md`, `server/assistant/skills/folio-mcp/SKILL.md`.
- **Tests**: `server/assistant/toolAccess.test.ts`, `server/comments.test.ts`, `server/documentEditing.test.ts`, `server/documentEdits.test.ts`, `server/mcp.test.ts`, `server/writingRules.test.ts`, `web/src/app/collabFileStatus.test.ts`, `web/src/app/collabOffline.test.ts`, `web/src/app/offline/syncEngine.flush.test.ts`, `web/src/editor/collab.test.tsx`, `web/src/editor/index.dom.test.tsx`.
- **Runtime TypeScript**: `server/assistant/tools.ts`, `server/collab.ts`, `server/documentEdits.ts`, `server/documentPersistence.ts`, `server/mcp.ts`, `server/mcpOutputSchemas.ts`, `server/pageDoc.ts`, `server/routes.ts`, `server/writingRules.ts`, `shared/contracts.ts`, `shared/documentPersistence.ts`, `web/src/app/collabFileStatus.ts`, `web/src/app/collabOffline.ts`, `web/src/app/offline/syncEngine.ts`, `web/src/editor/collab.ts`, `web/src/editor/index.tsx`.
- **Runtime UI styles/translations**: `web/src/editor/editor.css`, `web/src/editor/i18n/en.json`, `web/src/editor/i18n/uk.json`.
