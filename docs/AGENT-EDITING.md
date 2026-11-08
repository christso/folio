# Shared document editing for external agents

Browser users and authorized bots edit the same document through Folio. Bots use REST or MCP; they do not need a Git clone or a Yjs client. Markdown files and published Git remain the content record. This increment changes document bodies only.

## Read, guard, edit, read back

1. Resolve the intended page within an authorized space. Use `read_page(id)` over MCP or `GET /api/pages/:id` with a personal access token. Document results contain `markdown` and `revision`. MCP `fetch` also returns `revision` for its exact document `text`.
2. Prepare a body replacement or exact ranges against that body. Keep the revision unchanged; never calculate one from a truncated excerpt, a Git file, or an older cached read.
3. Send MCP `update_page` with `id` and the body below, or REST `PUT /api/pages/:id` with that body. Use an editor role and a write scope. OAuth works on MCP only; REST uses a PAT or browser session. Authentication and inherited page restrictions still apply.
4. Read back and reconcile the result. Someone may already have typed more by the time the write response arrives.

Replacement body:

```json
{
  "expectedRevision": "<revision returned by the read>",
  "markdown": "# Example\n\nReviewed text.\n"
}
```

For a read body `# Example\n\nOld text.\n`, change only `Old`:

```json
{
  "expectedRevision": "<revision returned by the read>",
  "edits": [{ "from": 11, "to": 14, "expectedText": "Old", "text": "New" }]
}
```

Offsets are zero-based UTF-16 code units, `to` exclusive, in the LF-normalized body, including its exact final newline. Every range refers to the same original body. Request order does not matter. Empty ranges insert text with `expectedText: ""`; empty replacement text deletes it. Multiple occurrences of a phrase are addressed by their explicit ranges. Overlapping ranges, duplicate insertion positions, partial Unicode characters and text mismatches are rejected before any mutation. A stale revision conflicts even if the proposed range was untouched. Under continuous typing, repeated read/prepare/write attempts can keep conflicting; there is no reservation or fairness guarantee. Keep retries bounded, reread and reconsider each proposal, and ask for a quiet moment when needed. Never substitute the new revision into an old edit blindly.

Requests accept exactly one of `markdown` or `edits` (1–100 ranges), without metadata fields. Edit strings together and the resulting body are limited to 1 MiB of UTF-8; individual strings are also bounded. REST's HTTP request-size limit still applies, including JSON overhead. Use LF and complete Unicode characters. Leading YAML frontmatter is refused: use the properties API with its own ETag for metadata. The existing frontmatter remains in the file.

## Passage replacement during unrelated typing

For a change whose intent is “replace this exact unique passage wherever it occurs in this page”, use MCP `replace_page_text` or REST `POST /api/pages/:id/replace-text`:

```json
{
  "oldText": "The retry limit is three attempts.",
  "newText": "The retry limit is five attempts."
}
```

MCP also takes `id`. Read the complete page first and choose enough exact context to express the intended passage. The server resolves and checks the quotation against the restored current body, then mutates synchronously. Unrelated typing can continue without a network read/write revision gap. Existing `update_page` and offset/full-body REST PUT retain strict revision checks.

Exactly one nonempty occurrence must exist, including overlapping matches. Missing, changed or duplicate quotations return bounded 409 `quote_conflict` without mutation. A changed result must consume the source quotation throughout the entire resulting body, including across replacement boundaries. A no-op may keep the same quotation and confirms persistence without attribution. True appends that preserve the source passage use strict guarded ranges; do not rewrite prose just to consume a guard. Limits, Unicode/LF checks, frontmatter protection, permissions, attribution and persistence results are the same as strict editing.

This is explicit location-independent intent. It does not prove semantic continuity if surrounding context changed or an identical passage moved. There is no fuzzy search, occurrence-index fallback or automatic conversion of stale offset edits. Immediate replay normally fails because its quotation was consumed. A later author can restore the old quotation, so this is not durable exactly-once journaling. A lost response or 503 still requires readback and reconsideration.

## Supported assistant recovery

The built-in Agent-mode assistant actually calls these MCP tools. Its wrapper handles a body conflict by returning a complete authorized `read_page` result for reconsideration. It shares a two-conflict budget per page/run across `update_page` and `replace_page_text`; once exhausted, further body writes stop with `edit_retry_budget_exhausted`. Read-only inspection remains available. The wrapper serializes its own concurrent body calls and never silently swaps revisions or replays a mutation. Sustained changes to the intended passage may legitimately require a quiet moment or a new owner decision.

A failed, denied or oversized recovery read returns `reconsider_read_unavailable` without a usable revision. Unknown write outcomes, including persistence failure, block further body writes with `edit_outcome_unknown` until an explicit complete read. Reconsider the user request against that read; if the intended change is already present, a guarded no-op can confirm the current file state after storage recovers. A separate two-uncertain-write budget per page/run survives those explicit reads; after the second uncertain write, further body writes stop with `edit_outcome_unknown`. Gate refusals and failed reads do not consume another write outcome. No response claims publication.

These controls run in the built-in assistant tool wrapper. External MCP clients receive the new tool and bounded errors, but must implement their own task-level retry budget and user explanation. This patch does not install or migrate a production editing adapter.

## Conflict and completion results

A successful response includes the page metadata plus:

```json
{
  "revision": "<accepted body revision>",
  "changed": true,
  "persistence": "file",
  "publication": "pending"
}
```

The existing page metadata `status: "published"` describes its workflow state, not a remote Git publication receipt.

`revision` identifies the accepted body, not a Git commit, an event sequence, or a reservation. Identical body content can have the same revision again. Revision checks cover edits received by the server before the transaction; offline and in-flight browser operations subsequently merge with ordinary Yjs semantics. The server checks and mutates synchronously, retaining characters outside the affected ranges. Replacements retain the shared prefix and suffix; use targeted edits for separated changes to preserve more character identities.

Success confirms a Markdown or MDX file write/check and collaborative snapshot persistence. MDX imports, components and expressions outside the edited range are opaque body text and stay intact. A no-op reports `changed: false` and does not claim authorship or start a new commit. The connected user's existing identity is recorded for accepted changes; commits retain Folio's last-editor-per-space behavior and may include other pending edits. There is no per-request Git commit or new audit-receipt store.

| REST status / code | Meaning and action |
|---|---|
| 428 `revision_required` | Legacy bot write lacks a guard. Read and pass `expectedRevision`. |
| 409 `revision_conflict` | The body changed. Returns `currentRevision`, without current content. Read, reconcile and prepare a new edit. |
| 409 `range_conflict` | A range overlaps, splits a character, is invalid, or mismatches `expectedText`. Returns a bounded `editIndex` and `currentRevision`. Fix the edit after reading. |
| 400 `invalid_body_edit`, `invalid_body_text`, `frontmatter_not_allowed` | Invalid shape or body. No mutation. Schema-level validation can also return 400 before the guarded handler. |
| 413 `body_edit_too_large` | Input or resulting body exceeds the limit. Schema-level character/count limits may return 400; HTTP size limits may return 413. |
| 503 `body_persistence_failed` | The edit may already be live, but file/snapshot persistence was not confirmed. Returns `acceptedRevision`. Read back and inspect persistence before retrying; do not report saved or publish based on this error. |

Browser document UI separates connection, server receipt, and file/snapshot confirmation. `File saved` requires the exact body and canonical collaborative history to match a server persistence receipt. New typing, pure deletions and identical text under newer character identities invalidate that confirmation. A visible failure survives typing/reconnect until matching recovery. Automatic retries are limited; after storage recovers an editor can choose `Retry file save`, which flushes the current writer without replacing text. Readers receive guidance to ask an editor. Keep the tab open or export a copy while unconfirmed. Missing verification capability/receipts are explicitly unconfirmed.

Document offline copies and background flush records are cleared only after both server receipt and file/snapshot confirmation. Share sessions retain their existing policy of no IndexedDB copy. Offline browser state overrides a stale connected tooltip. Git publication stays explicitly unconfirmed, separate from these file-save cues.

MCP returns the same bounded guarded-error object as JSON text in an `isError` result. Invalid MCP schemas may instead return SDK validation errors. Authorization failures use existing interface semantics; they reveal no body or revision. Snapshot acquisition failures fail closed, preserving stored state.

A transport failure leaves the outcome unknown. Read back first. An exact retry with an old revision normally conflicts once the first call changed the body, preventing a duplicate range insertion. A no-op retry can succeed. This is content preconditioning, not durable exactly-once request journaling: if content later returns to the original value, a retry can apply again. Workflows needing durable receipts must retain their existing journals.

Legacy unguarded MCP `update_page` and PAT REST document-body PUT now fail with a precondition error. Legacy cookie REST body PUT remains compatible and unguarded; it can replace newer typing and is not the bot editing contract. Browser typing still uses Yjs. Metadata-only PUT, structured page kinds, internal link/tag rewrites, history restore and structural operations retain their own existing semantics.

The built-in assistant keeps its existing 120,000-character tool-response budget. If a document's serialized result exceeds it, the assistant receives an explicit error and a read-only preview without an edit revision. Use external MCP or REST for a complete read/edit of that document within the 1 MiB edit limit. A truncated preview must never be submitted as a complete replacement.

## Publication policy and migration

Folio's existing Git behavior is unchanged: edits in an automatically synchronized space can be committed and pushed after the quiet period. This API is not a draft queue or a publication approval gate. Approve the specific write and its destination's existing publication policy before submitting it. If a workflow requires review before publishing, keep preparation outside that auto-publishing space until approval or retain the existing approved publisher.

Migrate one caller and destination at a time after owner review:

1. Inventory that caller's current spaces, page/path allowlists, privacy scopes, original-source exclusions, publication approvals and expected receipts. Preserve those boundaries. Folio's write scope is not a custom narrow note-writer grant; an adapter must keep any narrower destination rules it already enforces. Excluded source folders must stay excluded, and original captures remain immutable under the existing workflow policy.
2. Test a local adapter against synthetic pages. Resolve page ids through Folio's authorized tree/resolve surfaces; never add a raw filesystem/path endpoint or mount a repository into each bot. Read exact bodies and revisions, send minimal edits, surface conflicts for reconciliation, and preserve unknown outcomes until readback.
3. Prove bot-to-browser and browser-to-bot behavior, denied private/ancestor-restricted pages, malformed requests, same-revision competition, failure/retry behavior and unchanged frontmatter. Keep research, household, personal and work destinations separate; no additional index or bot grant follows from this patch.
4. Verify publication separately through the existing authorized Sync/status flow and published-branch file readback. HTTP 200 with conflict/error state is not success. Keep the existing fetched-commit and indexed-commit receipts distinct. Shared published readers and indexes continue to consume the published Git branch, not live Folio bodies or private working drafts.
5. Switch only the approved single-page caller after explicit operational authorization. Keep its old path available for reconciliation of in-flight requests; never run both writers on the same pending request. No live caller, configuration, credential or deployed service has changed merely because this patch exists.

Multi-page wiki operations (a page, its index and a log) are separate writes through this API. They can partially succeed and can be auto-published between calls. They are not an atomic multi-page publisher. Keep those operations on the existing shared host publisher until a separately reviewed transaction/adaptation contract exists. Preserve its expected file hashes, selected-file staging, durable request identity/journal, publication verification, note-save receipts and approval semantics. Structured note-save clients are not migrated here, and their existing indexing-pending responses must keep their meaning.

The operator's later rollout still needs backup/restore proof, the fork's conflict-recovery regressions, a built-container/browser check and owner behavior approval. Do not remove deletion/binary conflict records, reset snapshots or disconnect editors to force convergence.
