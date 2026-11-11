# Upstream v0.4.5 sync and issue #11 assessment

Assessed 11 November 2026 against upstream `94f4e0a6e9f83bd84f80ae097e47910242b7bd99`
and fork `b593f06c4ce826426dd9b834de0229e91778f8e4`. The fork base contains
deployment commit `a3b8222d0561c2f675680e5b4f92376d5800f767`; the maintained
integration branch is now `christso/main`, following fork PR #5.

## Verdict

Issue #11 does not make any deployed guarded-editing safeguard removable.
It led to a real, released upstream fix for one overlapping behavior, rather
than a proposal alone. The fork keeps its stronger contracts and accepts
upstream revision fields through its guarded room path.

The complete [issue](https://github.com/evergreen-it-dev/folio/issues/11),
its only [comment](https://github.com/evergreen-it-dev/folio/issues/11#issuecomment-6737695852),
and the issue timeline were inspected. The timeline references
[commit 61fa777](https://github.com/evergreen-it-dev/folio/commit/61fa777f49bd165d0a40d14ca879e2d6cf77fbd7).
There is no linked upstream PR, and GitHub's commit-to-PR query returned no
associated PR. The fix is an ancestor of both published tags
[v0.4.4](https://github.com/evergreen-it-dev/folio/releases/tag/v0.4.4) and
[v0.4.5](https://github.com/evergreen-it-dev/folio/releases/tag/v0.4.5).
The issue remains open. Release inclusion does not establish a production
rollout of this fork.

## What the code replaces

| Contract | Upstream implementation | Fork decision |
| --- | --- | --- |
| Reject a stale whole-page replacement | `bodyRevision` read result and optional `baseRevision`; missing precondition remains unconditional | Keep required bot preconditions; support upstream fields with the existing strict planner |
| Cold document restoration and comparison | File path remains possible, with an explicit residual room-opening race in the upstream comment | Keep restored-room reads/leases and synchronous guarded planning/mutation |
| Exact ranges and unique passage replacement | Not implemented by the issue fix; maintainer explicitly excludes targeted edits | Keep both APIs and their matching/input limits |
| Page-location precondition and queued authorization | Not added by the issue fix | Keep location fences and authorization rechecks, including proposal submission/acceptance |
| File/snapshot confirmation and offline recovery | No matching receipts or bounded recovery in the issue fix | Keep browser save receipts, serialized persistence and assistant recovery limits |

Original implementation evidence:
[upstream revision/edit code](https://github.com/evergreen-it-dev/folio/blob/61fa777f49bd165d0a40d14ca879e2d6cf77fbd7/server/collab.ts#L2656-L2767),
[upstream MCP contract](https://github.com/evergreen-it-dev/folio/blob/61fa777f49bd165d0a40d14ca879e2d6cf77fbd7/server/mcp.ts#L1134-L1180),
[deployed fork editing code](https://github.com/christso/folio/blob/a3b8222d0561c2f675680e5b4f92376d5800f767/server/documentEdits.ts),
[fork guarded-editing PR #2](https://github.com/christso/folio/pull/2), and
[fork location/authorization PR #3](https://github.com/christso/folio/pull/3).
The older unresolved-Git-conflict patch had already been retired by `971aaf4`;
that was separate upstream work and is not a removal enabled by issue #11.

## Integration decisions

- Both read revisions are computed from the same restored body. Existing
  `expectedRevision` remains page-bound. A supplied `baseRevision` is checked
  before converting to the existing planner; if both are present, both must
  match. No unconditional MCP/API-token replacement is reintroduced.
- Upstream review mode queues validated full/range edits while keeping
  location/access checks. Direct passage tools and token renames are refused
  in review mode. Proposed results do not claim file persistence/publication.
- Proposal acceptance is bound to the exact proposal version shown in the UI
  and the exact restored body checked before the decision claim. Queued
  authorization is rechecked, conflicts leave the proposal pending, and
  accepted existing-page changes confirm file/snapshot persistence.
- Proposal submission reuses its leased body instead of acquiring the same
  room again. New-page proposal keys include the space. A removed page cannot
  expose its saved proposal after its access restrictions disappear.
- The browser retains file-save status beside upstream's updated editor
  layout. Review success is tied to the proposal actually decided.

## Verification

Node 22 typecheck and the production Docker image build passed. The image
build includes the frontend build and SDK/Codex native dependency checks.
The focused proposal and review-dialog run passed 23 tests. The final Node
22.23.4 regression run passed **696 tests across 62 files** (233 seconds),
covering all changed test files plus the collaboration, location/fence,
guarded editing, file-status, offline cleanup and editor integration suites.
Earlier exploratory runs used host Node 26; the final result above uses the
Node 22 release/CI runtime. No full-suite result is claimed.
A disposable Docker build and browser exercise used synthetic content only.
The final image also passed an actual review-dialog acceptance: the UI sent the
proposal revision, the proposal became accepted and the page body changed to
`Status: reviewed.`.
The browser addition was confirmed on the server before a stale REST write:
HTTP 409 `revision_conflict`; a unique passage edit then returned HTTP 200,
`persistence: file`, `publication: pending`; the browser sentence and the
requested passage change both survived reload. This is a bounded smoke check,
not proof of every offline or cross-tab interleaving.

No production deployment, restart, credential change or knowledge write is
part of this sync. Migrations 061–064 belong to the imported releases and were
applied only to disposable test databases.

## Deferred upstream creation-flow concerns

Independent review found two pre-existing concerns in the newly imported,
optional new-page proposal flow. They are outside the deployed body-edit
contracts preserved by this sync and require a focused follow-up before a
production rollout relies on review-mode page creation:

- If creating a new page succeeds but writing its proposed body fails, the
  proposal is reopened. Retrying can create another page instead of resuming
  the first. Acceptance should retain the created page identity across the
  failed attempt. See upstream
  [decision rollback](https://github.com/evergreen-it-dev/folio/blob/94f4e0a6e9f83bd84f80ae097e47910242b7bd99/server/proposals.ts#L350-L366)
  and [creation path](https://github.com/evergreen-it-dev/folio/blob/94f4e0a6e9f83bd84f80ae097e47910242b7bd99/server/proposals.ts#L385-L406).
- New-page acceptance checks reviewer access before claiming the proposal,
  then awaits database work before creation. It does not recheck that access
  immediately before creating the page. A focused follow-up should cover
  revoked creation access during that wait. The existing-page acceptance path
  is guarded and rechecks authorization in this sync.

These findings do not authorize deployment or configuration changes. They are
recorded here and in the sync PR, without filing unrelated upstream issues.
