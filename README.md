# Can upstream plus PR #14 replace the fork?

**The ordinary browser, API/MCP and Git editing workflows worked in these tests.
Upstream plus PR #14 is not a drop-in replacement for the existing broker, and
it does not reproduce every fork contract.** A small upstream-only test client
successfully replaced a unique passage while preserving newer browser typing.
Retiring the fork still requires a client migration and an explicit decision
about location and persistence guarantees that upstream does not expose.

This run uses synthetic content, real browser keyboard/click actions, native
REST and HTTP MCP, and a separate Git clone pushing to a real smart-HTTP Git
remote. It does **not** inject storage failures, database locks, application
exceptions, timing delays inside requests, or process crashes. It does not
modify the application source or use private/production content.

## Exact versions

- Latest upstream fetched before this run: [`94f4e0a6e9f83bd84f80ae097e47910242b7bd99`](https://github.com/evergreen-it-dev/folio/commit/94f4e0a6e9f83bd84f80ae097e47910242b7bd99), v0.4.5.
- Upstream plus [PR #14](https://github.com/evergreen-it-dev/folio/pull/14): [`c5545fdfed40cf421bd44dc8716d71c3cd8b2f21`](https://github.com/christso/folio/commit/c5545fdfed40cf421bd44dc8716d71c3cd8b2f21).
- Maintained-fork controls: [`2e048814d1ea83fa6d3d03285d6e330b52a010e5`](https://github.com/christso/folio/commit/2e048814d1ea83fa6d3d03285d6e330b52a010e5), not a claim about a production rollout.
- App image: `sha256:dba95538409d983182407525bca0321d45287f1dfb1906e64413b877ee149b1f`.
- Fork control image: `sha256:d2803d61e2e2d4556f48789e681fef49e6a8fd4645a6136984e9b2e3c81c63b7`.
- Chrome 151.0.7922.77, agent-browser 0.33.2, Node 22.23.4, Git 2.54.0, Linux.

Critical runtime sources were compared byte for byte with each exact commit.
[Upstream hashes](receipts/upstream-runtime.json), [fork hashes](receipts/fork-runtime.json).
The separate Git HTTP fixture adds Git's CGI backend to its transport container;
it does not change the Folio app image or intercept its requests.

## Results

| Workflow | Result | Recording |
| --- | --- | --- |
| Two independent browser sessions type concurrently | Both sentences appear once and survive reload in both browsers | [MP4](videos/upstream-twoBrowsers.mp4) |
| Browser typing, then one MCP passage change with a current `baseRevision` | Browser Undo/Redo works; agent change survives | [MP4](videos/upstream-apiUndo.mp4) |
| Stale REST update after newer browser typing | 409 `revision_conflict`; newer sentence retained; explicit reread/reconciliation succeeds | Included in the MCP recording above |
| Same single-passage edit through REST | Browser Undo/Redo works; reload, REST, MCP and file agree | [MP4](videos/upstream-restUndo.mp4) |
| Browser, MCP and separate Git clone all edit different passages | All three changes survive Sync, remote publication and reload. Browser Undo afterward is ineffective in the no-final-newline case below | [MP4](videos/upstream-threeWriters.mp4) |
| Browser and Git agent change the same line | Visible conflict retains both versions; unresolved merge is not pushed; explicit MCP resolution plus Sync publishes the chosen result | [MP4](videos/upstream-gitConflict.mp4) |
| Native client replaces a unique quotation after unrelated browser typing | Fresh read plus guarded PUT retains the newer sentence. Missing/ambiguous quotations stop in client preflight without another PUT | [MP4](videos/upstream-quote.mp4) |
| Native MCP proposal, then browser Accept | Page unchanged while pending; acceptance retains browser sentence; reload/readbacks agree | [MP4](videos/upstream-review.mp4) |
| Editor role revoked after read | Subsequent normal REST write returns 403 without changing the page | [Receipt](receipts/contract-checks.json) |
| Page renamed after agent read | Body revision stays the same; native page-ID update follows the renamed page. Resolving the old path again returns 404. This is upstream ID semantics, not a location precondition | [Receipt](receipts/contract-checks.json) |

### Undo limits and the fork comparison

| Case | Observed behavior | Recording |
| --- | --- | --- |
| One upstream request changes two distant words around a browser sentence | Undo cannot remove that sentence afterward; all text remains saved | [MP4](videos/upstream-twoEdits.mp4) |
| Two separate native requests, each with a freshly read revision | Undo removes the middle browser sentence; both agent changes remain. **The two requests are not atomic together** | [MP4](videos/upstream-twoEditsSequential.mp4) |
| Fork exact-range API changes both words in one request | Undo removes the middle browser sentence; both agent changes remain | [MP4](videos/fork-twoEdits.mp4) |
| Git sync changes an earlier word after browser typing at EOF without Enter | Both edits retained, but browser Undo is ineffective | [Upstream MP4](videos/upstream-gitUndo.mp4), [fork MP4](videos/fork-gitUndo.mp4) |
| Same upstream Git case, with Enter typed after the browser sentence | Browser Undo works | [MP4](videos/upstream-gitUndoFinalNewline.mp4) |

The Git Undo failure is shared by the maintained fork. It is not evidence that
keeping the fork solves it. The newline control changes the outcome; the likely
mechanism is an earlier text change plus the file's canonical final newline
causing the common-prefix/suffix updater to replace the intervening text.
That explanation is an inference from the observed control and
[`setYText` / merge reconciliation](https://github.com/christso/folio/blob/c5545fdfed40cf421bd44dc8716d71c3cd8b2f21/server/collab.ts#L2550-L2605),
not an injected server condition.

The two-range fork control intentionally uses a different API operation:
`expectedRevision` plus two exact `edits`. Upstream cases use only native
`baseRevision` and `markdown`. This is a capability comparison, not a claim
that the fork's whole-body replacement has arbitrary multi-span diffing.

## What still prevents switching the existing client unchanged

The existing broker was exercised against the isolated upstream instance using
its real HTTP client, a synthetic grant and a new private test journal.
It rejected the native read with `unsupported_page`: it requires `revision`,
where upstream returns `bodyRevision`. Its quote endpoint `/replace-text`
returned 404 on upstream. Native guarded read/replace/read succeeded in a
separate small test client. [Compatibility receipt](receipts/client-compatibility.json).

A read-only check of the active transport source confirmed that the same
revision and write-receipt requirements remain there. No infra checkout,
production broker, bot settings or credentials were changed. The source and
internal deployment configuration are not included in this public evidence.

A migration must address these concrete differences:

1. Use native `bodyRevision` / `baseRevision`, with guards on every write and
   bounded explicit reconciliation after conflicts. Do not silently send the
   fork's `expectedRevision` to an upstream endpoint that does not support it.
2. Replace the single-quote tool with a current read, exact unique-quote
   validation, and a guarded native PUT. The positive test demonstrates this
   path. The tests do not establish behavior under every possible interleaving.
3. Handle the native write response. It lacks the fork's `revision`, `changed`,
   `persistence: file` and `publication: pending` receipt contract. Readback must
   not be relabelled as a durable-save confirmation.
4. Decide how to retain path-bound scope. A read/resolve before writing can
   notice a completed move, but does not recreate the fork's atomic
   `expectedLocation` guard across the write. The normal rename test shows
   that the native content revision does not cover location.
5. If callers require both separated changes to be one atomic edit while
   retaining middle-text Undo, two requests are not equivalent to exact ranges.

The tests support migrating ordinary passage-editing functionality. They do
not authorize removing the broker's existing safety checks, changing production,
or claiming complete fork parity. No additional upstream issue or PR was
created as part of this verification run.

## Evidence and coverage

There are 13 completed browser cases, plus live client-compatibility and API
contract checks. A separate [post-run reload/Source audit](receipts/route-audit.json) rendered all 13 upstream pages with zero uncaught errors and zero console errors; it is not retroactive console capture of every earlier interaction. Failed Undo checks remain marked `FAIL` / `LIMITATION` in the
receipts; successful text retention is not presented as successful Undo.
[Machine-readable summary](receipts/summary.json), [all receipts](receipts/),
[video hashes](receipts/video-hashes.json).

The two-browser case initially stopped before interaction because its browser
page did not initialize. A fresh isolated browser retry completed the actual
case. Stopped setup/harness attempts are not counted as product failures or
passing cases. This is a bounded functional run, not a stress test or a measure
of production frequency. No artificial backend fault paths are used.

Recordings show the actual automated browser UI, followed by an explicitly
labelled result screenshot held for readability. Captions below the viewport
identify invisible API/Git actions and distinguish assertions made by readbacks.
Original captures are retained privately. Exports were fully decoded and their
chronological frames, outcomes, captions and privacy were inspected. Generated
MP4s are confined to this orphan evidence branch, outside code history.

## Reproduce

Use a disposable host/runtime with Docker Compose, Python 3, Node 22, Git and
agent-browser 0.33.2 with its browser installed. The fixtures use loopback app
and Git ports and an isolated Docker network. PostgreSQL trust auth and the
anonymous synthetic Git remote are for this local fixture only. There is no
connection to production or any real Git remote.

```sh
git clone https://github.com/christso/folio.git /tmp/folio-retirement-source
export FOLIO_SOURCE=/tmp/folio-retirement-source
git -C "$FOLIO_SOURCE" checkout --detach c5545fdfed40cf421bd44dc8716d71c3cd8b2f21
(cd "$FOLIO_SOURCE" && npm ci --no-audit --no-fund)
docker build -t folio-retirement-app:c5545fd "$FOLIO_SOURCE"
# From this evidence checkout:
docker build -f repro/GitRemote.Dockerfile -t folio-retirement-git-http:20261112 repro

# Copy only reproduction source to a fresh private runtime.
FOLIO_RETIREMENT_RUN=$(mktemp -d /tmp/folio-retirement-repro.XXXXXXXX)
cp -R repro/. "$FOLIO_RETIREMENT_RUN/"
cd "$FOLIO_RETIREMENT_RUN"
python3 prepare-runtime.py upstream
docker compose -p folio-retirement-20261112 --env-file .env -f compose.yaml up -d
node setup.mjs
node api-browser.mjs apiUndo
node api-browser.mjs restUndo
node api-browser.mjs twoEdits
node git-browser.mjs gitUndo
node git-browser.mjs threeWriters
node git-browser.mjs gitConflict
node two-browsers.mjs
node contract-checks.mjs
node add-controls.mjs
node api-browser.mjs twoEditsSequential
node git-browser.mjs gitUndoFinalNewline
node quote-review.mjs quote
node quote-review.mjs review
```

Setup creates synthetic users/PATs through public REST, seeds a real Git remote,
and imports it through `POST /api/spaces`. Per-case scripts generate browser
captures and receipts. Run each case once on a fresh seed. A returned `FAIL`
receipt for a measured Undo failure is an observed result, not a driver crash.
Do not publish `.env`, `fixture.private.json`, browser storage or unfiltered logs.

For the optional fork controls, build the maintained fork commit with the tag
`folio-retirement-app:2e04881`, copy `repro/` to another fresh runtime, run
`prepare-runtime.py fork`, start project `folio-retirement-fork-control-20261112`,
and run `setup.mjs`, `git-browser.mjs gitUndo`, then
`FOLIO_TEST_EXACT_RANGES=1 node fork-api-browser.mjs twoEdits`.
A snapshot of the private transport clone is needed only for the optional
`compatibility.mjs` audit, through `FOLIO_CLIENT_SOURCE`; it is not a dependency
of the public Folio workflow reproductions.

Cleanup only the project you created, using that runtime's compose file and
`.env`, for example:

```sh
docker compose -p folio-retirement-20261112 --env-file .env -f compose.yaml down --volumes
```
