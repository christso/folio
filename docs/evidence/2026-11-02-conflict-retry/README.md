# Unresolved conflicts after a Sync retry

These screenshots compare unchanged Folio with a patched fork using the same synthetic note in two isolated instances. Both page deletions and both Sync attempts used the browser menus. No real wiki data or credentials are included, and the screenshots have not been edited.

You delete a note in Folio while another writer updates it in Git. Both versions initially warn about the conflict. After another Sync, upstream removes the warning, keeps the note and pushes the merge without a resolution. The deletion was not applied, although Folio reports success. The fixed version keeps the conflict flagged and leaves remote main unchanged.

| Capture | Meaning |
|---|---|
| [Original note](01-upstream-before-deletion.png) | One heading and one original paragraph |
| [Note deleted](02-upstream-note-deleted.png) | Note has disappeared locally; deletion is waiting to sync |
| [First Sync](03-upstream-first-conflict.png) | Upstream reports the conflict and withholds the merge |
| [Retry on upstream](04-upstream-after-retry.png) | Warning disappears and the merge is published without a choice |
| [Retry on the fixed version](04-fixed-after-retry.png) | Warning and affected-page entry remain; the merge is withheld |

The note is available locally in both final views so it can be reviewed. Its presence alone does not prove publication. The accompanying Git receipt records the remote commit before and after each retry.

Upstream package: 0.4.2, source base 9a4b30b9065fa1dc05b8bcec2fe75f7710a430cf. Fixed source: e4de9bac7748c30c77129ab367a06291748bd3b3. Candidate fix: https://github.com/christso/folio/commit/0e1e0d9a6a6384e9d04249fc3c49aa714dd6598b.
