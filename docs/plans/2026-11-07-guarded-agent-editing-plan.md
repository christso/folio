---
title: Guarded shared document editing for agents
date: 2026-11-07
type: feat
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Guarded shared document editing for agents

## Goal Capsule

**Objective:** Authorized bots and browser users can edit the same Folio documents without a bot silently replacing changes received since its read.
**Means:** Body revisions and guarded replacements or exact ranges through the existing live document (KTD1–KTD3).
**Authority:** The owner's request and repository invariants govern. Implementation and local verification are authorized; publication, deployment, live caller migration and permission/credential changes are excluded.
**Execution profile:** One local feature branch based on deployment commit `2d2ae63`, preserving the conflict-recovery patch. The orchestrator implements sequentially and returns behavior and evidence for owner review. Any later release requires owner approval.

---

## Product Contract

### Summary

Expose a bounded single-document editing contract through REST and MCP. Bots need no repository clone or raw Yjs protocol. Published Markdown/Git and existing downstream readers remain the record of publication.

### Problem Frame

`editDocBody` currently deletes and reinserts the entire live body. MCP and nearby comments promise merging that does not protect browser edits received after a caller's read. Separate bot clones also require coordinated synchronization and do not reserve a page.

### Requirements

**Shared editing**

- R1. A document read returns a revision of exactly the returned LF-normalized Markdown body, excluding frontmatter.
- R2. Bot replacements require the read revision. Stale writes fail with bounded conflict metadata and no mutation or attribution change.
- R3. Targeted edits validate nonoverlapping ranges and their exact expected text against one revision, then apply all changes atomically to Y.Text. Preserve unrelated CRDT characters and frontmatter.
- R4. Validation and mutation have no intervening await. Cold writes restore the existing snapshot before editing; browser/offline state and conflict recovery remain intact.

**Access and completion**

- R5. REST and MCP keep existing roles, inherited page restrictions, `.agent` rules and read/write scopes. Hidden or excluded content gains no path-based bypass. Inputs, edit counts and resulting body sizes are bounded.
- R6. A successful write reports the accepted revision, whether content changed, and file persistence separately from pending Git publication. A failed persistence attempt must not report success; a lost response requires readback and reconciliation rather than an unsafe blind retry.
- R7. Record the connected user's existing Git identity only for accepted changes. No-op and conflict calls do not claim authorship. Existing quiet-period commits keep their last-editor semantics.
- R8. Legacy unguarded MCP callers and token REST body writers receive a useful precondition error. Preserve the existing browser cookie PUT compatibility explicitly as an unguarded legacy operation, without safe-merge claims. Guarded requests use a body-only contract; metadata APIs remain separate.

**Integration boundary**

- R9. Keep existing structured multi-file note publication, request journals, receipts, selected staging, source protections and approvals. A page/index/log sequence through single-page APIs is not an atomic publisher.
- R10. Document a staged migration and verification procedure that preserves private scope separation and published readers/indexing. No live bot switches paths in this work.

### Scope Boundaries

The increment covers document bodies only. Tables, forms, boards, bases, metadata changes, history restore and structural operations retain their existing contracts. Considered and not built: raw bot Yjs clients (unnecessary protocol burden), automatic rebasing of stale ranges (could change intent), a new multi-page journal/publisher (existing publisher already provides it), per-edit Git commits (would change publication policy), and body request-id storage (revision checks plus readback prevent duplicate application; durable exactly-once receipts remain with the existing publisher).

### Deferred to Follow-Up Work

Production adapters, bot credentials/configuration, approval-aware staging before Folio's auto-publishing spaces, atomic multi-page transactions, and replacing legacy cookie body PUT are follow-up work. Before routing a bot, approve the destination's existing automatic Git publication policy; this API is not a draft approval queue.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Content revision, bound to page and exact body.** Read and write against the same fully restored Y.Text, including cold reads; file-only reads can differ from a snapshot in final newline or pending edits. Hash the page id and returned body with a version prefix. Do not reuse `fileBodyHash(docFileBody(...))`, which treats final newlines differently. A revision is an opaque content precondition, not a Git SHA or Yjs vector; identical body content can recur.
- KTD2. **One guarded editing primitive.** Extend `update_page` and REST document PUT with `expectedRevision` and mutually exclusive `markdown` or `edits`. Each edit carries UTF-16 `from`, `to`, `expectedText`, and replacement `text`; ranges refer to the same original body. Refuse overlap, duplicate insertion positions, mismatches and surrogate splits. A stale revision always conflicts, even for unrelated changes.
- KTD3. **Use restored live rooms for cold reads and edits.** Reuse `ensureDocSeeded`, do not delete snapshots or disconnect clients. Snapshot lookup or decode failure must fail acquisition, remove the failed room and leave stored state intact; file seeding requires confirmed snapshot absence. Check revision and all edit guards and transact synchronously. Whole replacements retain common prefix/suffix identities instead of recreating the whole body. Serialize API persistence with the existing writer, and reclaim API-only rooms safely after use; await closing-room persistence before a new seed and test lifecycle races.
- KTD4. **Honest completion and retry behavior.** Await verified file/snapshot persistence, retain normal retries on failure, and return an error that says an accepted edit may already be live. The accepted revision describes the operation's result; later browser typing can already have advanced it. Exact retries with an old revision conflict after a change; reread before deciding whether to resubmit. No-op requests do not schedule a commit.
- KTD5. **Keep existing security and publication ownership.** Authorization remains in the existing resolvers. Frontmatter is never submitted through guarded editing. No API response claims remote publication or indexing; existing authorized Sync and published-file verification remain required. Existing multi-file publisher remains authoritative for structured saves.

### High-Level Technical Design

```mermaid
sequenceDiagram
    participant Bot
    participant API as REST or MCP
    participant Room as Existing Yjs room
    participant File as Markdown and snapshot
    Bot->>API: Read authorized document
    API-->>Bot: Exact body and revision
    Bot->>API: Revision and replacement or guarded ranges
    API->>Room: Restore if cold; synchronous check and transaction
    alt precondition fails
        API-->>Bot: Bounded conflict; reread required
    else accepted
        Room->>File: Existing serialized persistence path
        API-->>Bot: Changed flag and accepted revision; publication pending
    end
```

Directional contract sketch: a write is `{expectedRevision, markdown}` or `{expectedRevision, edits: [{from, to, expectedText, text}]}`. No content or file paths are returned in conflicts. Compatibility depends on authentication: token body writes require the guard; legacy cookie body PUT remains explicitly unguarded.

### Evidence and Assumptions

Confirmed source: `collab.ts` seeding, snapshot recovery, body replacement and persistence; `storage.ts` file lock and frontmatter-preserving write; `mcp.ts` and `routes.ts` existing checks; `pageDoc.ts` live-first reads; `mcpOutputSchemas.ts` structured reads. `contentSafety.test.ts`, `mcp.test.ts`, `shareCollab.test.ts` and `pageAccessInherit.test.ts` provide real storage/auth/socket seams. The deployment tree matches the stated tested source. No CE model/provider override is configured in this checkout.

Local patterns establish the selected approach; no new dependency or external protocol is introduced. Private operational references were inspected read-only and supply only the generic integration constraints in R9–R10; no operational identifiers belong here.

---

## Implementation Units

### U1. Shared contract and guarded body operations

**Goal:** Define and validate exact body editing. **Requirements:** R1–R5, R8. **Dependencies:** None.
**Files:** `shared/contracts.ts`, new `server/documentEdits.ts`, `server/documentEdits.test.ts`.
**Approach:** Define shared request/result schemas first. Implement revision and pure range planning with explicit limits and bounded typed errors. Use one resulting change set for live mutation.
**Patterns:** Existing Zod contracts and ETag conflict precedents.
**Test scenarios:** Exact final-newline and page-id revisions differ; stale input is refused; out-of-order nonoverlapping ranges preserve text; repeated expected strings use explicit ranges; overlap, duplicate insertions, surrogate splits, malformed requests and oversize results fail; no-op produces no change.
**Verification:** Focused pure tests establish the mutation decision independently of storage. They do not prove persistence or socket delivery.

### U2. Live-room integration and external interfaces

**Goal:** Make guarded writes consistent and durable through REST and MCP. **Requirements:** R1–R8. **Dependencies:** U1.
**Files:** `server/collab.ts`, `server/pageDoc.ts`, `server/routes.ts`, `server/mcp.ts`, `server/mcpOutputSchemas.ts`, new `server/documentEditing.test.ts`, affected existing tests.
**Approach:** Add the safe primitive alongside internal legacy writers, update read schemas, gate legacy bot calls, and expose the same edit contract in both interfaces. Preserve metadata-only browser calls and source exclusions. Observe real persistence failures, rather than treating void `flushDoc` as proof. Capture attribution at acceptance.
**Execution note:** Start with regression cases using actual Yjs and the repository's PostgreSQL/files/socket fixtures.
**Test scenarios:** Two bot writes from one revision yield one winner; browser edits before checking reject the bot; browser updates during awaited preparation cannot be overwritten; targeted edits preserve other text/frontmatter; delayed/offline edits survive Yjs merge; cold writes/readback survive restart; stale/no-op calls preserve attribution; persistence failure is not reported as saved; read-only scope/private/ancestor restrictions/`.agent` deny reads or writes without content leakage; REST and real MCP transport return compatible results.
**Verification:** Targeted server tests and existing collaboration/access regressions. Real browser validation covers a bot edit appearing in an open editor with typing retained; container validation covers the runtime when available.

### U3. Integration guide and owner review evidence

**Goal:** Make the increment usable without implying live migration. **Requirements:** R9–R10 and compatibility/completion in R6–R8. **Dependencies:** U2.
**Files:** `docs/MCP.md`, `docs/FEATURES.md`, `docs/LIMITATIONS.md`, `docs/HANDOFF.md`, `DEV-PLAN.md`, `CHANGELOG.md`, `README.md` fork inventory, assistant tool guidance, new `docs/AGENT-EDITING.md`.
**Approach:** Document exact requests, errors, retry/readback and pending publication. Describe allowlisted page resolution, preserved originals/private scopes, published Git readers/indexes, multi-page deferral and existing note receipts/approvals. Record verification and missing prerequisites in a local evidence artifact.
**Test expectation:** Documentation has no runtime behavior; verify examples against schemas and remove old merge guarantees. Assistant guidance must match tools/list.
**Verification:** Simplification, independent code review, affected tests, typecheck and build; inspect final diff for private identifiers and unintended production changes.

---

## Verification Contract

Run `npm run typecheck`, focused Vitest tests for document editing plus affected MCP/access/collaboration and preserved Git-conflict regression tests, then `npm run build`. Use disposable synthetic fixtures only. PostgreSQL/Redis and browser/container prerequisites must be probed and failures reported; never substitute mock success for missing integration proof. Resolve material review findings and rerun affected checks. Do not run the full suite by default.

## Definition of Done

All units have concrete local changes and relevant verification evidence. Guarded bot writes cannot overwrite a newer accepted body, preserve unaffected text and frontmatter, obey existing access, and report completion accurately. Durable documentation and migration guidance are public-safe. Simplification and code review are recorded, material findings resolved, abandoned code removed, and every missing validation prerequisite is named. Return the plan path, branch/worktree, changed paths and exact checks. No deployment, publication or caller migration occurs.
