# Browser Undo after an ordinary document API update

Synthetic browser and HTTP MCP evidence captured on 11 November 2026.
This is an evidence-only orphan branch, separate from application history.

- Clean latest upstream: `94f4e0a6e9f83bd84f80ae097e47910242b7bd99` (v0.4.5), checked again before publication.
- Fixed: `c5545fdfed40cf421bd44dc8716d71c3cd8b2f21`, that baseline plus the focused text-identity patch, regression tests and documentation.
- Both instances use the production Docker build, Node 22.23.4, PostgreSQL 17 and Redis 7, on loopback ports with disposable data.

## The ordinary user story

1. A person types a sentence into a shared document.
2. An agent reads that current document, including the person's sentence and its `bodyRevision`.
3. The agent changes only `Status: draft.` to `Status: reviewed.`, supplying that matching `baseRevision` to HTTP MCP `update_page`.
4. The person presses Ctrl+Z to undo their own sentence, then Ctrl+Y to redo it.

No stale write, injected database lock, forced response delay, concurrent acceptance or production/private record is involved. The clean baseline accepts the update correctly, but its whole-text Yjs replacement recreates the unchanged sentence and its character identities. Browser Undo no longer removes that sentence. The patch reuses Folio's existing `setYText` helper to retain the unchanged prefix and suffix, including complete Unicode surrogate pairs at splice boundaries.

| Observed assertion | Clean upstream | Baseline plus patch |
| --- | --- | --- |
| Agent reads the browser sentence before editing | Yes | Yes |
| MCP supplies the matching read revision | Yes | Yes |
| API edit succeeds and both changes initially appear | Yes | Yes |
| Ctrl+Z removes the person's sentence | No | Yes |
| Ctrl+Z preserves the agent's Status change | Yes | Yes |
| Ctrl+Y restores the person's sentence after Undo | Undo was ineffective | Yes |
| Final browser reload and REST/MCP agree | Yes | Yes |
| Current Markdown file contains the final text | Yes | Yes |

## Recordings and receipts

- `before.mp4`: 24.5 seconds, 166112 bytes.
- `after.mp4`: 40.1 seconds, 279566 bytes.
- `before-receipt.json` and `after-receipt.json`: sanitized assertions, actual text readbacks and runtime/file SHA-256 hashes.
- `SHA256SUMS`: hashes for the published evidence files.

The real browser is driven through `agent-browser`; typing, Ctrl+Z and Ctrl+Y are automated keyboard input, not physical-device testing. The viewport is 1280×720. H.264/yuv420p MP4s add a high-contrast 110-pixel caption footer below it, with fast-start metadata. Captions identify the invisible MCP action and observed results. The final frame is held for five seconds while reporting the separate reload/readback assertions. Caption timing was checked against exported frames; the after Redo caption is aligned with the observed restoration frame. Recording lengths reflect setup/confirmation waits and are not latency measurements. Raw WebM captures remain in private temporary runtime storage.

Relevant running server files were compared byte for byte with their pinned Git commits. The original before capture checked `server/collab.ts`; its unchanged hash and the other runtime-source hashes were checked again after capture. The after runner checks all listed runtime sources before acting. The production image contains built frontend assets rather than frontend source; no frontend implementation changes are part of the patch.

The three added regression instances failed on clean upstream at the Undo/relative-position assertions. On the patch, **57 tests passed** across `server/updatePageRevision.test.ts`, `server/collab.test.ts` and `server/collabTables.test.ts`, using Node 22.23.4 and real isolated PostgreSQL/Redis. Typecheck and the production Docker/frontend/native build passed. Focused source review and an independent local adversarial read completed with no findings. No full-suite or production-incidence claim is made.

## Reproduce on empty disposable instances

Requires Docker Compose, a Folio clone, Node/npm, `agent-browser` with Chromium/Chrome, FFmpeg with libx264/libass and FFprobe. Use fresh containers: the seed creates fictional users and a new direct-mode space. The runner refuses non-loopback URLs and container names outside `folio-edit-history-*`. No real credentials are needed.

Build clean checkouts of the exact commits:

```sh
git fetch upstream main
git fetch https://github.com/christso/folio.git agents/tsoyang/preserve-document-edit-history
git worktree add --detach /tmp/folio-history-before 94f4e0a6e9f83bd84f80ae097e47910242b7bd99
git worktree add --detach /tmp/folio-history-after c5545fdfed40cf421bd44dc8716d71c3cd8b2f21
docker build -t folio-edit-history:before /tmp/folio-history-before
docker build -t folio-edit-history:after /tmp/folio-history-after
docker compose -p folio-edit-history -f compose.yaml up -d
```

Install the pinned dependencies in the fixed checkout, then return to this evidence directory:

```sh
cd /tmp/folio-history-after
npm ci --no-audit --no-fund
cd /path/to/evidence-directory

FOLIO_SOURCE=/tmp/folio-history-after \
node reproduce.mjs before

FOLIO_SOURCE=/tmp/folio-history-after \
FOLIO_FIXED_COMMIT=c5545fdfed40cf421bd44dc8716d71c3cd8b2f21 \
node reproduce.mjs after

python3 export-video.py before
python3 export-video.py after
```

The seed and app restart happen only in these disposable containers, before the recorded scenario. The same case runs on both versions through the real browser and HTTP MCP. Explanatory pauses are in the harness only. The export's after Redo caption alignment is specific to this recorded take; inspect and adjust that timestamp against any new capture before publishing it. Remove only this disposable Compose project when done. Do not target an existing instance or production database.

This proves one ordinary editing sequence and the corresponding regression contracts. It does not implement targeted-passage APIs, arbitrary text merging, mandatory revision policy, save-confirmation/recovery, or all remaining fork protections. It does not make the fork removable by itself.
