# Google Docs editing comparison

Assessed 12 November 2026 using synthetic plain text. Folio upstream baseline:
`94f4e0a6e9f83bd84f80ae097e47910242b7bd99`. [PR #14](https://github.com/evergreen-it-dev/folio/pull/14)
implementation: `c5545fdfed40cf421bd44dc8716d71c3cd8b2f21`. Fork baseline:
`2e048814d1ea83fa6d3d03285d6e330b52a010e5`.

## What we learned

Google Docs preserved browser Undo and Redo after a targeted API edit in our
test. Deleting and reinserting the whole body left the browser user's earlier
sentence visible after Undo. The limitation is therefore also observable in
Google Docs under that operation; this does not establish an industry-wide
limitation or the behavior of every Google Docs editing path.

PR #14 improves Folio's whole-body API by keeping unchanged prefix and suffix
characters. It does not preserve unchanged text between two separate changes.
It does not provide full Google Docs feature parity.

## Google Docs live test

The owner used a signed-in browser. The agent used the connected native Google
Docs API on the same synthetic document. The document identifier and raw
account-related capture details are deliberately excluded from this report.

1. The owner reopened the document, typed `Second browser note: test undo.`,
   waited for it to save and kept the tab open. API readback confirmed it.
2. A batch with the current `requiredRevisionId` deleted only `reviewed` from
   the Status paragraph and inserted `confirmed`. Exact body readback showed
   that all other text, including the browser sentence, remained unchanged.
3. The owner pressed Undo once and reported the sentence disappeared. API
   readback confirmed its absence and retained `Status: confirmed.`. Redo
   restored the sentence; the complete body again matched the post-API body.
4. For the second case, the owner reopened the document, typed
   `Whole-body test: keep this sentence.`, waited for save and kept it open.
5. After a fresh read, a guarded atomic batch deleted all editable body text,
   preserving Google's mandatory terminal newline, then inserted the complete
   body with only the status changed to `whole-body replaced`. This used
   `deleteContentRange` plus `insertText`, not a minimal splice or
   `replaceAllText`. Exact readback confirmed the expected body.
6. The owner reported that Undo did not remove the new browser sentence. The
   initial status observation was ambiguous. The owner then quoted the complete
   visible body, matching the replacement, and pressed Undo again with that
   state visibly confirmed. Everything stayed the same. API readback exactly
   matched the post-replacement body.

An earlier first attempt was abandoned because the owner closed the tab before
the requested Undo; no result is claimed for that attempt. The completed
targeted-edit test used a fresh browser insertion after reopening.

| API mutation | Browser Undo of the earlier sentence | Evidence |
| --- | --- | --- |
| Replace one small range | Removed the sentence; Redo restored it; API status retained | Owner action reports and independent API readbacks |
| Delete/reinsert the whole editable body | Sentence remained after Undo; replacement status retained | Owner action reports, explicit visible-state confirmation and independent API readbacks |

Separate controlled API interleavings also verified stale `requiredRevisionId`
rejection, `targetRevisionId` transformation across a newer insertion, and
atomic rejection of a batch with an invalid range. Those used one connected
identity and sequential API calls, not two simultaneous browser editors.

Google's [batch guide](https://developers.google.com/workspace/docs/api/how-tos/batch)
documents multiple requests applied atomically in request order. Its
[write-control reference](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate#WriteControl)
distinguishes strict revision checking from transformation against a recent
revision. These references establish API contracts, not browser Undo semantics.

## Signed-in browser follow-up

After the owner signed into a disposable agent-browser session, the agent ran
both cases directly in Chrome 151.0.7922.77 on Linux. Each started in its own
synthetic tab with this single paragraph:

```text
First: old. Middle: original. Last: old.
```

Real browser keyboard input inserted `Browser note: keep this sentence. `
after `First: old. `. A native API read confirmed that insertion before the
API changed both `old` words to `new`. Both changes were visibly confirmed in
the browser before Ctrl+Z. The browser was not reloaded between typing and Undo.

| API operation | Browser Undo of the middle sentence | Redo | Final reload |
| --- | --- | --- | --- |
| One native `replaceAllText` request matching the entire paragraph, retaining the middle sentence in its replacement string | Did not remove it; both API changes remained | Not used to infer success after ineffective Undo | Exact replacement retained |
| Two separate word-range mutations in one atomic batch | Removed it; both API changes remained | Restored it; both API changes remained | Exact post-API text retained |

The first case did not explicitly request separate deletion and insertion of
the whole body. It gave Google's native replacement operation one old paragraph
and one new paragraph. Its visible Undo result still did not preserve the
browser insertion in the unchanged middle. That is evidence about this
operation's behavior, not proof of Google's internal diff algorithm.

The targeted control used four ordered requests: delete/insert the final word,
then delete/insert the first word, all under the same `requiredRevisionId`.
The initial read immediately after Ctrl+Y still showed the Undo state; a later
read confirmed Redo after propagation. No second Redo was sent. Assertions
therefore use the settled readback, not the first response.

[Sanitized requests, bodies, assertions and receipt digests](live-browser-results.json)
record the exact comparison. To repeat it, use a fresh synthetic paragraph and
a fresh browser insertion for each case, substitute the actual tab and revision
IDs, then send the recorded requests. Verify the API changes are visible before
Undo and wait for readback to catch up after browser input.

Private recordings were cropped to the synthetic editor text and captioned.
The raw recordings, screenshots, editor-only MP4s and REA metadata remain
private; no Google account or document identifiers are published here. REA
connected to the selected Docs target and inspected page metadata; no captured
client source or proprietary server implementation is claimed. The temporary
browser, viewer and local login profile were closed and removed after the tests.

## Two separate edits in Folio

PR #14 uses the existing
[`setYText` helper](https://github.com/christso/folio/blob/c5545fdfed40cf421bd44dc8716d71c3cd8b2f21/server/collab.ts#L1018).
It finds one common prefix and one common suffix, then replaces everything
between them. With changes near the top and bottom, unchanged middle text is
still deleted and reinserted. A browser insertion in that middle region can
lose useful Undo. Text after the last change can retain its identity.

The [bounded probe](google-docs-two-edits.mjs) executes that exact pinned helper
with real Yjs 13.6.32. It also models the fork's
[descending range mutations](https://github.com/christso/folio/blob/2e048814d1ea83fa6d3d03285d6e330b52a010e5/server/collab.ts#L2744).
The [recorded output](google-docs-two-edits.json) shows:

| Mutation | Browser sentence between edits | Browser sentence after edits |
| --- | --- | --- |
| PR #14, one whole-body request with two changed words | Undo did not remove it | Undo removed it |
| Two explicit range mutations in one transaction | Undo removed it | Undo removed it |

Both requested word changes survived Undo in all four cases. Redo returned
each case to its exact post-API body. This probe does not run Folio REST/MCP,
its validation, authorization or persistence, or the Google Docs browser.

To reproduce from a Folio checkout containing the pinned PR commit and the
project's installed dependencies, using the project's supported Node runtime:

```sh
node fork-research/2026-11-12-google-docs/google-docs-two-edits.mjs /absolute/path/to/folio
```

## What parity would require

Google Docs accepts separate range requests in a single atomic batch. The
signed-in browser control above confirmed Undo/Redo preservation between two
such edits in this case. A native replacement matching the entire paragraph
did not preserve that behavior. Automatic multi-span diffing in Folio would
add convenience to its whole-body API; this comparison does not establish that
Google offers the same automatic behavior.

The fork already accepts multiple exact ranges against one strict revision,
and applies only those ranges. PR #14 alone does not expose that API upstream.
The fork also has a unique-passage tool that tolerates unrelated typing; its
matching rules differ from Google's revision transformation. These are useful
overlapping capabilities, not proof of identical semantics.

For an agent changing two passages, separate validated mutations preserve more
editing history than one enclosing replacement. A future upstream change
could expose exact ranges or use a bounded multi-span diff internally. Either
would need its own scope, regression coverage and browser evidence; this report
does not expand PR #14 or claim that work is implemented.

## Evidence limits and provenance

The initial tests used owner-performed browser actions and independent API
readbacks. The follow-up used real browser automation after owner login,
private recordings and independent API readbacks. No authenticated REA source
capture, cursor measurement or proof of Google's private algorithms is
claimed. Google Docs recordings remain private; the public Folio PR videos
demonstrate Folio only. No production Folio service or private record was
used or changed.

Raw connected-API receipts remain in private runtime storage. Their SHA-256
digests identify the records without publishing document or revision IDs:

| Private receipt | SHA-256 |
| --- | --- |
| Targeted-edit Undo | `e9be2b0e2c2892d92d363ef0861175800a11ce663cfb2213a07803ec999a187f` |
| Targeted-edit Redo | `c43970457c444cbfa9486ba2c4b4d4938d444080d6633708405a2ae1266e0ca2` |
| Confirmed whole-body Undo | `63578f616e0744f3365766786e94a8084933947dfa3fe3da65f8dc8bc22404b3` |
| Revision/atomic API interleavings | `2bba40acb5ce92b34e1f81f160f9f661c496015d27ce6788fdd279734c9fbdc6` |

The broader fork-removal decision still requires revision, targeted-edit,
location/access, proposal-approval and persistence protections to be assessed
separately. See [the upstream sync assessment](https://github.com/christso/folio/blob/2e048814d1ea83fa6d3d03285d6e330b52a010e5/docs/verification/upstream-sync-0.4.5.md).
