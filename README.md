# Folio recovery and retry failures — 12 November 2026

Three real browser reproductions against clean upstream **v0.4.5**, commit
`94f4e0a6e9f83bd84f80ae097e47910242b7bd99`. Upstream was fetched again before
reporting. These are fault-injection tests with synthetic data, not measurements
of how often users encounter the failures. No production service or content was used.
No code fix is included. This is an orphan evidence branch, with no code-history parent.

| Case | Control | Injected failure | Observed result |
| --- | --- | --- | --- |
| Snapshot restore | [MP4](videos/snapshot-control.mp4) | [MP4](videos/snapshot-fault.mp4): cancel one cold snapshot SELECT | Existing text appears twice after an old/offline browser reconnects. Reload, REST, real HTTP MCP and current file retain the duplicate. No snapshot was deleted. |
| Proposal retry | [MP4](videos/proposal-control.mp4) | [MP4](videos/proposal-fault.mp4): one EIO on the initial proposed body rename | First Accept fails after creating a heading-only file. Retrying the same pending proposal creates a second file. A replay after successful acceptance correctly returns 409. |
| Browser recovery retention | [MP4](videos/durability-control.mp4) | [MP4](videos/durability-fault.mp4): block both page file and snapshot saves, then crash disposable app | On navigation, browser deletes its recovery database while both durable copies lack the edit. After app memory is lost, the edit is gone. **Requires both save failures plus process loss. A file write failure alone does not establish this result.** |

All six runs completed their assertions and passed again on an independent fresh instance using the published harness. The repeated durability runs additionally decoded the browser recovery database and confirmed it contained the edit before deletion. [Repeated run summary](receipts/repeated-run-summary.json). Receipts are in [receipts](receipts/).
The critical runtime source files were compared byte for byte with the pinned
upstream commit; hashes are in each receipt and [runtime.json](receipts/runtime.json).
The captured local image was
`sha256:fa7984772702704c073251866f59a4040b4b5891f165605996708efd04541429`.
The optional I/O fault shim is outside the application source and is normally inert.
It is not a patch to Folio's implementation.

## What the videos show

The recordings show the actual browser UI and actual clicks/keyboard input.
Captions describe injected invisible faults and identify assertions made through
IndexedDB, PostgreSQL, REST, MCP and files. They are not synthetic server responses.
The final segment is an actual result screenshot held for nine seconds, explicitly
labelled as a held screenshot. Some footage is slowed for readability; each clip's
edit timeline records the speed. The snapshot result screenshot precedes the final
reload assertion; the receipt records that the same text remained after reload.
The other result screenshots show the page after reload/reopen.

The review dialog may contain Folio's first-run tour hints. Older synthetic
proposal and control pages remain in the sidebar from stopped harness attempts;
the reported retry case is specifically `proposal-retry-evidence.md` and
`proposal-retry-evidence-2.md`. Stopped attempts were not counted as passing runs.
The export was decoded and its chronological frames, captions and result images
were inspected. [Video/file hashes](receipts/video-hashes.json) include the private
original capture hashes and public result screenshot hashes. Original captures are
retained privately; generated MP4s are only on this evidence branch.

Browser: agent-browser 0.33.2, Chrome 151.0.7922.77 on Ubuntu Linux. Browser actions
were automated real browser interactions, not a physical-device test.

## Reproduce in a disposable instance

Requirements: Docker Compose, Python 3, Node 22.12+ (recorded host used 22.23.4),
agent-browser 0.33.2 with Chromium installed, and ffmpeg for optional export.
Use a fresh isolated checkout and runtime directory. The harness intentionally
pins the loopback address, container names and SQL database. It must never point
at an existing deployment. The PostgreSQL trust configuration is only for this
disposable instance. No Git remotes, real user records or external sync are configured.

```sh
# Use absolute paths of your choosing; keep this checkout/runtime disposable.
git clone https://github.com/evergreen-it-dev/folio.git /tmp/folio-upstream-evidence
export FOLIO_SOURCE=/tmp/folio-upstream-evidence
git -C "$FOLIO_SOURCE" checkout --detach 94f4e0a6e9f83bd84f80ae097e47910242b7bd99
(cd "$FOLIO_SOURCE" && npm ci --no-audit --no-fund)
docker build -t folio-recovery-evidence:94f4e0a "$FOLIO_SOURCE"

# From an evidence-branch checkout, copy only repro/ to a fresh private runtime.
FOLIO_AUDIT_RUN=$(mktemp -d /tmp/folio-recovery-repro.XXXXXXXX)
cp -R repro/. "$FOLIO_AUDIT_RUN/"
cd "$FOLIO_AUDIT_RUN"
python3 prepare.py
docker compose -p folio-recovery-audit-20261112 --env-file .env -f compose.yaml up -d
# Wait for http://127.0.0.1:54897/api/health, then seed synthetic fixtures.
python3 seed-runtime.py

node snapshot-reproduce.mjs control
node snapshot-reproduce.mjs fault
node proposal-reproduce.mjs control
node proposal-reproduce.mjs fault
node durability-reproduce.mjs control
node durability-reproduce.mjs fault
```

Each case is intended to run once on a fresh seed. A successful run writes its
receipt and original browser capture under its own directory. Browser login uses
random synthetic credentials from a mode-0600 fixture file, and the MCP PAT stays
in process memory, not shell arguments. Do not publish the fixture, `.env`, browser
storage state or unfiltered logs.

The snapshot driver stops the disposable app, types while disconnected, holds a
PostgreSQL table lock before restarting, selects the exact blocked snapshot-read
query, cancels it once, and immediately releases the lock. It does not delete or
corrupt the stored snapshot. Reads that hydrate the room are deliberately avoided
before the injected cold lookup.

The proposal driver submits once over real HTTP MCP and accepts through the real
browser review dialog. The one-shot shim fails only the exact body marker/path
rename, before replacing the target file. It allows the initial title-only create.
The partial file is read directly without opening its collaborative room before retry.

The durability driver uses a page-scoped `NOT VALID` CHECK constraint to reject
new snapshot writes while preserving the existing row, plus the exact-page rename
fault. It observes a connected badge and in-memory REST text while durable hashes
stay unchanged. It navigates via the actual sidebar, checks the recovery IndexedDB
has disappeared, kills only the disposable app, clears faults after memory is gone,
and reopens the page. The SQL constraint is removed in cleanup.

Cleanup only the named disposable project after collecting your private artifacts:

```sh
docker compose -p folio-recovery-audit-20261112 --env-file .env -f compose.yaml down --volumes
```

## Google Docs comparison and limits

A fresh signed-in Chrome session used an existing synthetic comparison document.
A normal online typing control saved successfully. With browser networking disabled,
Google Docs briefly accepted `Offl` from an attempted longer sentence, then stopped
accepting input in this session, whose offline availability was not configured.
The server API still returned the old text while disconnected. The UI displayed
`Saving…` / `Trying to connect.` rather than `Saved to Drive`. After reconnect,
`Offl` saved once, and API readback after reload matched. The baseline appeared once.
[Sanitized comparison receipt](receipts/google-comparison.json).

This does **not** prove Google Docs' backend storage or snapshot-failure behavior.
We cannot cancel Google's snapshot lookup, block its durable stores or reproduce
Folio's two-stage new-page proposal acceptance there. No Google internal algorithm,
industry-wide failure or exact feature parity is inferred. Google account UI, document
identifiers, login/session material and raw Google captures are excluded from publication.
The earlier targeted-edit/Undo comparison belongs to separate research linked from PR #14.

## Source locations

- [Snapshot load failure becomes absence](https://github.com/evergreen-it-dev/folio/blob/94f4e0a6e9f83bd84f80ae097e47910242b7bd99/server/collab.ts#L2256-L2260), then [file reseeding](https://github.com/evergreen-it-dev/folio/blob/94f4e0a6e9f83bd84f80ae097e47910242b7bd99/server/collab.ts#L2312-L2321).
- [Proposal creation precedes body write](https://github.com/evergreen-it-dev/folio/blob/94f4e0a6e9f83bd84f80ae097e47910242b7bd99/server/proposals.ts#L378-L396), while [failed acceptance resets to pending](https://github.com/evergreen-it-dev/folio/blob/94f4e0a6e9f83bd84f80ae097e47910242b7bd99/server/proposals.ts#L344-L360).
- [Browser cleanup uses memory acknowledgement](https://github.com/evergreen-it-dev/folio/blob/94f4e0a6e9f83bd84f80ae097e47910242b7bd99/web/src/app/collabOffline.ts#L183-L190) and [clears the recovery copy on disposal](https://github.com/evergreen-it-dev/folio/blob/94f4e0a6e9f83bd84f80ae097e47910242b7bd99/web/src/app/collabOffline.ts#L255-L268).

These are separate from issue #11's released stale `baseRevision` protection and
PR #14's document-edit Undo fix. No report treats intentional writes without
`baseRevision` as a new defect.
