# Guarded agent editing: verification and owner review

Verified on 8 November 2026 on `feat/guarded-agent-editing`. The initial implementation at `68c9901` used deployment `2d2ae63` (the same source tree as `e4de9ba`). The feature branch now merges deployment `971aaf471d3cdb9c9d4ea700070114dff43cb9a6` without rewriting published history. The original checkout remains untouched.

Draft review: [PR #2](https://github.com/christso/folio/pull/2). Plan: [Guarded shared document editing](../plans/2026-11-07-guarded-agent-editing-plan.md). Contract and migration boundary: [Shared agent editing](../AGENT-EDITING.md).

## Integrated release gates

| Check | Final result |
|---|---|
| `npm run typecheck` | Passed, exit 0 |
| Targeted Vitest command below | 14 files, 187 tests passed, 117.50 seconds, exit 0 |
| Affected integration-fix tests | 3 files, 36 tests passed, 35.40 seconds, exit 0 |
| `npm run build` | Passed, exit 0; 3.75 seconds, existing large-chunk warning |
| Dockerfile build | Passed on Node 22 Alpine, including production install and native SDK check |
| Running-container source comparison | All 9 changed production modules match local SHA-256 hashes |
| `git diff --check` | Passed |
| Final real-browser/caller pass | 8 scenarios completed on the final image; UX limitations below remain |
| Complete outgoing public-suitability check | 30 text paths checked; no private operational paths/credential patterns or `.qa` files included |

```sh
npx vitest run server/documentEdits.test.ts server/documentEditing.test.ts \
  server/collab.test.ts server/mcp.test.ts server/contentSafety.test.ts \
  server/shareCollab.test.ts server/pageAccessInherit.test.ts \
  server/assistant/toolAccess.test.ts server/gitMerge.test.ts server/gitNative.test.ts \
  server/gitSyncConflicts.test.ts server/comments.test.ts server/mdxPages.test.ts \
  server/writingRules.test.ts
```

Tests use disposable PostgreSQL schemas, Redis, real files/Yjs documents, MCP SDK transport and collaboration sockets. The full repository suite was not run. Proof-first checks failed before each integration fix: room destruction, an unresolved persisted anchor, and a premature empty writing-rule read. An intermediate 14-file run also encountered the newly introduced writing-rule regression before its fix; it is superseded by the final run below. Existing dual-Yjs, Node localStorage and build chunk-size warnings remain. Schema-isolated tests and the browser app use separate disposable databases; separate test processes also use separate databases.

The runtime image is built from the integrated tree using the repository Dockerfile on Node 22 Alpine, including its keyless native SDK check. All nine changed production modules match their SHA-256 hashes in the running container. Final image: `sha256:333d95dd398bcb940caca56b5fdb9aa36cb49e6a574f7c3c6696d71f4f288154`. The app uses a synthetic private space with no remote Git binding. File persistence and local quiet-period Git commits are exercised; remote publication and downstream indexing are not.

## Real-browser adversarial pass

Driver: Compound Engineering `ce-test-browser` in pipeline mode, using the installed `agent-browser` headless Chrome driver. Two independently authenticated browser sessions represent two different synthetic people with editor access. Browser changes use actual keyboard/mouse actions in Folio's Source editor, not injected editor transactions or raw Yjs updates. A separate local fixture client acts as the bot through authenticated REST. It is a test caller, not a production adapter or integrated bot UI.

| Scenario | Observed result |
|---|---|
| Two people type in different paragraphs while a bot prepares an edit | Both additions converge in both rendered editors and API readback. The delayed bot receives 409. A real reread and reconsidered exact edit retains both people's text and appears in both browsers. |
| Two people edit the same paragraph at different positions | Prefix and suffix edits both survive and converge. This does not prove that competing prose at the same insertion gap is semantically coherent. |
| Selection and local undo/redo after a remote bot edit | The selected first paragraph stays selected when the bot changes the second. Undo removes the person's local marker while preserving the bot edit; redo restores only that marker. On this Linux browser Control+Y works; Control+Shift+Z did not redo. |
| Offline typing, online peer plus bot, reconnect, reload | Offline typing remains absent from the online peer until reconnect. The online person's edit and bot edit survive alongside it. Reload retains all three changes without duplication. The offline banner is visible; a connection-tooltip inconsistency is recorded below. |
| Bounded retries during continued typing | Eight reads followed by a 400 ms preparation delay each receive 409 while ordinary character-by-character typing continues. A quick fresh read/edit succeeds between keystrokes while typing is still running. A reconsidered fresh edit after the typing pause succeeds. No reservation or fairness guarantee exists. |
| Bot inserts text before a person's caret | The caret remains in the intended second paragraph; the person's next typed suffix lands there, and both browsers/API converge. The initial caret location is checked before the bot action. |
| Successful write response is dropped | A loopback proxy forwards one write, receives 200, then closes before replying to the fixture caller. The caller sees an unknown outcome. Replaying the original request receives 409; reread and both browsers show exactly one insertion. No request-id journal is implied. |
| File persistence fails while people are editing | A reversible fault makes only the synthetic page's destination unwritable. The bot gets 503 with `acceptedRevision`; its change is visible in both browsers, and a person can continue typing. After storage is restored, reread plus a guarded no-op returns `changed: false`, `persistence: file`, `publication: pending`. Both people's text and the single prior insertion survive. Browser receipt cues do not surface the file failure. |

All eight scenarios were repeated successfully on the final integrated image after the comment and writing-rule fixes. These results cover two actual browser sessions plus the separate REST fixture caller. They do not establish production bot integration, remote Git publication, downstream indexing, or a comprehensive browser/container restart test. The prior narrow single-browser check is superseded for these scenarios.

Videos, screenshots, action logs and fixture results are retained locally under the untracked `.qa/guarded-agent-editing/dogfood/` directory. They are excluded from commits because runtime/browser data and synthetic tokens live there too. The public record is this sanitized report. The driver returned no browser errors or console entries for the completed deeper pass; server-side errors caused by the explicit persistence fault are expected and retained locally.

Earlier stopped harness runs are retained, not counted as passes. Recording starts reload the page, so the harness must wait for the editor before going offline. Rendered remote-cursor labels must be excluded when comparing visible document text. A wrapped first paragraph also exposed an invalid arrow-key caret assumption in the harness; the final test clicks the actual intended paragraph and verifies the caret before editing. Those were test corrections, not product fixes.

## Findings, fixes and remaining UX gaps

**Correctness regressions found at deployment integration and fixed locally:**

- Upstream comment anchoring had its own immediate room closer. A proof-first concurrent cold-anchor/guarded-save test showed it destroying the shared room. Anchoring now uses the same lease and idle cleanup as guarded editing. Anchors continue to resolve after an unrelated guarded edit and snapshot restoration.
- Removing that closer also removed its flush: after a cold external-file reconciliation, a comment could refer to character identities not yet persisted. The regression resolved the returned relative position to `null` in the immediate stored snapshot. Anchoring now awaits successful serialized file/snapshot persistence before returning positions, and refuses to acknowledge an anchor on persistence failure.
- Upstream writing-rule reads could observe an empty room while a new cold read was seeding it. A blocked-seed regression demonstrated the premature result. Writing-rule document reads now use the restored-room reader; existing authorization and presentation trimming remain unchanged.

Additional integration proofs preserve opaque MDX imports/JSX/expressions, foreign frontmatter and the `.mdx` path; reject stale MDX edits; and retain an unrelated Y.Doc root across guarded editing, cleanup and reopen. Upstream's current Git conflict implementation and tests are unchanged relative to deployment. The retired fork-only conflict module is not restored. Migration of an old unresolved on-disk conflict ledger was not exercised against live data and is not claimed.

**Confusing behavior documented within this increment:** a page-wide content guard rejects unrelated changes during typing, and repeated prepared retries can starve. The integration guide now requires bounded retries and reconsideration, with a quiet moment when needed. It forbids replacing an old proposal's revision blindly. This keeps the chosen conservative contract.

**Larger pre-existing UX limitations, deferred:** the browser's green collaboration/acknowledgement cue remains during a server file failure because it indicates connection/receipt. The bot's 503 has no browser error presentation. In the offline experiment the offline header/banner was correct while the collaboration tooltip briefly still said connected. These cues do not prove file persistence or remote publication. A coordinated browser persistence-status protocol and its recovery UX require separate work; this patch does not invent one. The existing page metadata `status: published` is a page workflow state, not a remote Git publication receipt.

There is no integrated bot UI/adapter here, so actual user-facing conflict dialogs, retry explanations, approval handling and publication receipts cannot be validated. The fixture caller demonstrates the HTTP contract and explicitly treats 503/transport failure as uncertainty. It does not establish that an existing production bot communicates that uncertainty correctly. Owner behavior approval and adapter-specific dogfooding remain necessary.

## Review

Planning used `ce-plan` in pipeline mode; implementation used `ce-work` for local verification. The initial simplification and ten-lens native review resolved five distinct findings and reported none remaining. The bounded integration simplification preserves the shared room lease and proof tests. The completed integration review reported no remaining material findings after the comment durability and writing-rule read fixes. Its coverage used one fresh correctness context, a reused reliability context and eight inline lenses because the harness thread cap prevented additional fresh reviewers. No independent agreement or cross-provider coverage is claimed. The review examined the actual outgoing integrated diff; runtime checks above were run by the implementing agent, not independently rerun by reviewers. Owner behavior review remains pending and the PR remains draft.

No model/provider configuration was changed. Cross-provider review did not run. Review evidence is local; no upstream issue/PR or review comment was posted.

## Owner trial and integration boundary

In the isolated review app, open a synthetic page as two different editor users. Type in separate paragraphs, then prepare an exact REST/MCP body read and guarded edit. Type between read and write to observe the stale refusal, reread the complete body, reconsider the change and retry. Compare both editors and readback, then repeat offline/reconnect and undo/redo. Use the contract's examples rather than a copied cached revision. Treat any persistence failure or lost response as uncertain until checked; the browser's green connection cue is insufficient.

This patch is reviewable in a draft PR, with no PR merge, deployment, live caller migration, real vault edits, production permissions or credential changes. Git branch publication of this code is distinct from publishing wiki content. Shared published readers/indexes stay on their existing Git branch. Single-page APIs cannot atomically publish a page, index and log. Keep the shared multi-file publisher's expected file hashes, selected-file staging, durable journals, approval policy and note-save/publication/index receipts. A later migration must separately approve allowlisted destinations and privacy/source boundaries, test an adapter, verify its actual published branch and index, and switch a live caller only under separate authorization.

## Changed paths

**Documentation (10 paths)**

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

**Runtime agent guidance (5 paths)**

- `integrations/claude-code/skills/folio-wiki/SKILL.md`
- `integrations/codex-plugin/skills/folio-wiki/SKILL.md`
- `integrations/cursor-plugin/skills/folio-wiki/SKILL.md`
- `server/assistant/prompts/folio-context.md`
- `server/assistant/skills/folio-mcp/SKILL.md`

**Tests (6 paths)**

- `server/assistant/toolAccess.test.ts`
- `server/comments.test.ts`
- `server/documentEditing.test.ts`
- `server/documentEdits.test.ts`
- `server/mcp.test.ts`
- `server/writingRules.test.ts`

**Runtime TypeScript (9 paths)**

- `server/assistant/tools.ts`
- `server/collab.ts`
- `server/documentEdits.ts`
- `server/mcp.ts`
- `server/mcpOutputSchemas.ts`
- `server/pageDoc.ts`
- `server/routes.ts`
- `server/writingRules.ts`
- `shared/contracts.ts`
