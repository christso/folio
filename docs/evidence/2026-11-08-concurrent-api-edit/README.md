# Concurrent browser and MCP edits

A stale whole-page MCP update removed a newer browser sentence from the live
page and its current Markdown file. It remained absent after browser reload.
The guarded fork rejected the stale update; its targeted replacement then
changed the requested passage and retained the browser sentence after reload.
All pages, accounts and content in these captures are synthetic.

## Reproduce

Create a disposable document with this body and leave it open in the browser:

```markdown
# Concurrent editing example

Status: draft.

Original paragraph stays.
```

From the Folio repository, with dependencies installed, run:

```sh
FOLIO_URL=http://localhost:4870 FOLIO_PAGE_ID=<example-page-id> \
  FOLIO_TOKEN_FILE=/path/to/protected-write-token node \
  docs/evidence/2026-11-08-concurrent-api-edit/reproduce.mjs
```

Use an editor's write-scoped token. The script refuses to proceed unless the
page body matches the example. At its prompt, append
`Browser addition: keep this sentence.` in the browser and press Enter in the
terminal. It verifies that the sentence reached the server, then submits its
earlier copy with only `Status: draft.` changed to `Status: reviewed.`.

Upstream accepts the update and removes the browser sentence. The guarded fork
returns an MCP error and preserves it. Reload to check the final browser state.
The script uses a revision precondition when the reader supplies one.

## Captures and provenance

- `upstream.mp4`: actual browser recording of the overwrite through HTTP MCP.
- `fixed.mp4`: stale-write rejection, targeted replacement and reload.
- Four screenshots show the server-confirmed browser addition, upstream result,
  guarded rejection and final preserved text.
- `receipt.json` records server readbacks, current-file hashes and assertions.

The test-step strip is a harness annotation added to the page, not Folio UI.
MP4 playback is slowed eight times from the captured WebM, with a final
two-second hold, to make the steps readable.

The unmodified image was built from upstream
`18b3b945af799d85d1115ce65cf4951faacc6086` (package version 0.4.3). Its running
`server/collab.ts`, `server/mcp.ts` and `server/routes.ts` matched current upstream
`2dd626383e6e2462a642a3d99e6c97d3aa3f9894` byte for byte. This is not a claim
that the complete newer release was run. The guarded image was built from fork
`a3b8222d0561c2f675680e5b4f92376d5800f767`.

The disposable Docker Compose stack used PostgreSQL 17, Redis 7 and headless
Chromium 151 on Linux. No production data or services were used. The loss shown
is from the current page/file; Folio's recovery backup may retain the replaced
text, so these results do not establish permanent unrecoverable loss.
