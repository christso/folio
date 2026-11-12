# Browser Undo across two API edits

One real MCP `update_page` call changes `First: old.` and `Last: old.` to `new.` around an earlier browser sentence. Clean upstream leaves that sentence in place when the person presses Ctrl+Z. The patch removes only that sentence; Ctrl+Y restores it. Both agent changes survive. REST, MCP, reload and the current Markdown file agree.

- Clean latest upstream, fetched again on 12 November 2026: **94f4e0a6e9f83bd84f80ae097e47910242b7bd99** (v0.4.5).
- Fixed code: **bef6512503ee4ea67de8a08ea528194e45dafc95**, baseline plus PR #14. The prior single-span PR head was c5545fdfed40cf421bd44dc8716d71c3cd8b2f21.
- [Before MP4](before.mp4) / [after MP4](after.mp4): approximately 27 seconds each, H.264/yuv420p, under 210 KB each. Captions sit below the viewport. The final actual result screenshot is held for six seconds and labelled as such.
- [Before assertions](before-receipt.json) / [after assertions](after-receipt.json), [verification](verification.json), [video hashes](video-hashes.json) and [all file hashes](SHA256SUMS).

These are real browser keyboard actions in Chrome 151, automated with agent-browser 0.33.2, against isolated disposable Folio instances. Setup uses public REST endpoints and MCP `create_page`; the tested edit uses HTTP MCP with a freshly read, matching `baseRevision`. There is exactly one `update_page` call per case. The post-Undo body is checked independently through REST and MCP. There is no direct storage manipulation, forced network or server delay, injected failure, private record or production service in this reproduction. Source files inside each container are checked byte-for-byte against the stated commit before running.

## Run it

Requirements: Docker Compose, Git, Node 22.23.4 (or compatible Node 22), Python 3, agent-browser with Chromium installed, and ffmpeg with libx264 and DejaVu Sans. Run the commands below from this evidence checkout. Generated passwords, PATs and cookie state stay in the disposable run directory; do not publish it.

Clone the code separately, check out both exact revisions, install the host-side MCP SDK dependencies, and build the normal production images:

```sh
git clone https://github.com/christso/folio.git ../folio-code
git -C ../folio-code fetch origin agents/tsoyang/preserve-document-edit-history
git -C ../folio-code worktree add ../folio-before 94f4e0a6e9f83bd84f80ae097e47910242b7bd99
git -C ../folio-code worktree add ../folio-after bef6512503ee4ea67de8a08ea528194e45dafc95
npm ci --prefix ../folio-after
docker build -t folio-two-passages:before ../folio-before
docker build -t folio-two-passages:after ../folio-after
RUN_ROOT="$(mktemp -d /tmp/folio-two-passages.XXXXXXXX)"
FOLIO_SOURCE="$(realpath ../folio-after)"
export FOLIO_SOURCE
python3 scripts/provision.py before --root "$RUN_ROOT/before" --image folio-two-passages:before --commit 94f4e0a6e9f83bd84f80ae097e47910242b7bd99
python3 scripts/provision.py after --root "$RUN_ROOT/after" --image folio-two-passages:after --commit bef6512503ee4ea67de8a08ea528194e45dafc95
FOLIO_RUN_DIR="$RUN_ROOT/before" node scripts/setup.mjs
FOLIO_RUN_DIR="$RUN_ROOT/after" node scripts/setup.mjs
FOLIO_RUN_DIR="$RUN_ROOT/before" node scripts/reproduce.mjs
FOLIO_RUN_DIR="$RUN_ROOT/after" node scripts/reproduce.mjs
python3 scripts/export.py "$RUN_ROOT"
```

Each run starts a separate PostgreSQL, Redis and Folio, exposes Folio only on a dynamically allocated loopback port, and creates synthetic users and an empty local space through REST. No Git remote or external service is required. `runtime.json` gives its URL. The setup script creates the same document through MCP on each version:

```markdown
# Two passages

First: old.

Middle: original.

Last: old.
```

The reproduction script opens Source mode, types `Browser note: keep this sentence.` immediately after the middle line, waits until MCP can read it, then replaces both `old.` words using that current body and revision. It asserts both agent changes are visible before pressing Ctrl+Z. On `before`, the sentence must remain; on `after`, it must disappear. Both changed words must remain. It then presses Ctrl+Y, verifies the restored sentence, reloads, and checks REST/MCP/file readbacks. A mismatched result exits unsuccessfully.

For a manual run, use the generated browser account in the private fixture file, open the URL from `runtime.json`, and repeat those actions while making the same MCP read/update. The UI need not race with the request. The defect occurs even when the agent has read all browser typing first.

Clean up only the two generated projects and their disposable volumes:

```sh
python3 - "$RUN_ROOT" <<'PY'
import json, subprocess, sys
from pathlib import Path
for mode in ['before', 'after']:
    root = Path(sys.argv[1]) / mode
    runtime = json.loads((root / 'runtime.json').read_text())
    subprocess.run(['docker', 'compose', '-p', runtime['project'], '-f', str(root / 'compose.yaml'), '--env-file', str(root / '.env'), 'down', '--volumes'], check=True)
PY
```

## Scope and limits

The patch applies bounded Unicode character diffs inside the existing single Yjs transaction. It leaves the whole-body API contract, optional revision guard and other `setYText` callers unchanged. Beyond 1,024 inserted/deleted Unicode code points, it falls back to replacing one span; unchanged middle text inside that fallback does not gain this Undo guarantee. The regression suite checks separate paragraphs, one paragraph, repeated words, Unicode boundaries and exact large-fallback output, alongside the existing collaboration tests (62 passing tests). Node 22 type checking, the production Docker build and code review also passed.

This demonstrates the stated editing case, not production frequency, arbitrary merge behavior or complete fork parity. It makes no claim about other applications. This orphan branch contains evidence only and must not be merged into code history.
