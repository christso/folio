# Proposal acceptance can overwrite an edit received while the claim waits

Synthetic browser/HTTP MCP/REST evidence captured on 11 November 2026.
This is an evidence-only orphan branch: no application history or production data.

- Clean latest upstream: `94f4e0a6e9f83bd84f80ae097e47910242b7bd99` (v0.4.5).
- Fixed: `d8d0db83d947b7eb6d0ab4e6d3f29a99ce045b82`, that baseline plus the focused acceptance revision patch, regression and documentation.
- Both images: Node 22 Alpine, PostgreSQL 17, Redis 7, isolated local containers.
- Browser: automated Chromium keyboard input at a 1280×720 viewport. The MP4 adds a caption footer below that viewport.

## Observed results

| Assertion | Clean upstream | Baseline + patch |
| --- | --- | --- |
| MCP proposal includes `baseRevision` from `read_page` | Yes | Yes |
| Proposal initially leaves page unchanged | Yes | Yes |
| Browser addition confirmed by HTTP MCP before releasing acceptance | Yes | Yes |
| Acceptance response | HTTP 200 | HTTP 409 `revision_conflict` |
| New browser sentence survives reload, REST/MCP and current Markdown readback | No | Yes |
| Stored proposal status | `accepted` | `pending` |

[before.mp4](before.mp4) and [after.mp4](after.mp4) are H.264/yuv420p MP4s with fast-start metadata, about 20 seconds each and under 300 KB. Exported frames and caption timing were inspected, and both files were decoded completely without errors. The raw WebM captures remain in private temporary runtime storage and are not part of code history.

This is a remaining **proposal acceptance** path. Issue #11's released fix is present in the baseline. The initial MCP proposal supplies its read revision. This does not report the intentionally unconditional behavior of `update_page` without `baseRevision` as a new defect.

## What the harness does

1. Seed a fictional reviewer, agent, review-mode space and document in an otherwise empty disposable instance.
2. Use the real HTTP MCP server to read the page and submit a proposal with `baseRevision`.
3. Open the real browser editor. Hold the proposal row with a separate PostgreSQL `SELECT ... FOR UPDATE` transaction, then send the same REST acceptance payload as the review UI (`decision`, `currentHash`). Confirm that the real claim query is blocked using `pg_blocking_pids`.
4. Type `Browser addition: keep this sentence.` into CodeMirror with browser keyboard input. Confirm the newer text through HTTP MCP before releasing the row lock.
5. Release the claim, observe the actual response and browser result, reload, and assert matching REST/MCP/current-file outcomes and the proposal's stored status.

The row lock is an explicit test scheduling aid, shown in the captions. It makes the already asynchronous claim gap repeatable. No application function, browser result, response or persistence operation is mocked or replaced for capture. The acceptance is automated REST, not a physical click; typing is automated browser keyboard input. The scripts assert outcomes before writing a successful receipt.

## Reproduce on disposable instances

Requires Docker Compose, Git, Node 22, `agent-browser` with Chromium installed, FFmpeg with libx264/libass, and FFprobe. Run only on empty disposable containers; the seed deliberately creates new users/tokens. The runner refuses non-loopback targets and container names outside `folio-proposal-*`. No real credentials are needed.

Create clean code worktrees from an existing public Folio clone, then build the two images:

```sh
git fetch origin
git worktree add --detach /tmp/folio-before 94f4e0a6e9f83bd84f80ae097e47910242b7bd99
git fetch https://github.com/christso/folio.git agents/tsoyang/guard-proposal-acceptance
git worktree add --detach /tmp/folio-after d8d0db83d947b7eb6d0ab4e6d3f29a99ce045b82
docker build -t folio-proposal-scope:before /tmp/folio-before
docker build -t folio-proposal-scope:after /tmp/folio-after
docker compose -p folio-proposal-evidence -f compose.yaml up -d
```

Install the pinned JavaScript dependencies in the fixed code worktree (the runner resolves MCP/PG dependencies from `FOLIO_SOURCE`), then run from this evidence directory:

```sh
cd /tmp/folio-after
npm ci --no-audit --no-fund
cd /path/to/this/evidence-branch

FOLIO_SOURCE=/tmp/folio-after \
FOLIO_EVIDENCE_CONTAINER=folio-proposal-before-demo \
FOLIO_EVIDENCE_URL=http://127.0.0.1:54881 \
DATABASE_URL=postgres://folio:folio@127.0.0.1:55441/folio \
node reproduce.mjs before

FOLIO_SOURCE=/tmp/folio-after \
FOLIO_EVIDENCE_CONTAINER=folio-proposal-after-demo \
FOLIO_EVIDENCE_URL=http://127.0.0.1:54882 \
DATABASE_URL=postgres://folio:folio@127.0.0.1:55442/folio \
node reproduce.mjs after
```

The runner waits for server startup before seeding. A run needs a fresh instance; do not replay the seed against an existing database. The local ports in the recipe are examples and must be unused. Stop/remove only this disposable Compose project when finished. Do not point the runner at an existing instance or production database.

`before-receipt.json` and `after-receipt.json` contain the assertions, synthetic readbacks and SHA-256 hashes. The relevant runtime source files were compared byte for byte with the pinned Git commits. `SHA256SUMS` covers every published evidence artifact. Tokens, cookies and database sessions are excluded from the receipts and recordings.

The focused regression failed on clean upstream (expected 409, received 200), then 21 proposal/revision tests, Node 22 typecheck and the production/native Docker build passed on the patch. This is a bounded reproduction of edits received before acceptance resumes; it does not claim a general merge guarantee or production rollout.
