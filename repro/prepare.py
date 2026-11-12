from pathlib import Path
import secrets,subprocess,os
root=Path(__file__).resolve().parent
assert os.environ.get('FOLIO_SOURCE'), 'Set FOLIO_SOURCE to an isolated checkout of pinned upstream'
assert not (root/'data').exists(), 'Use a fresh disposable runtime directory'
for name in ['folio-recovery-audit-app','folio-recovery-audit-20261112-postgres-1','folio-recovery-audit-20261112-redis-1']:
 result=subprocess.run(['docker','container','inspect',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 assert result.returncode != 0, f'Container name already exists: {name}; do not touch another run'
root.chmod(0o711)
(root/'data').mkdir(mode=0o777);(root/'data').chmod(0o777)
(root/'.env').write_text('FOLIO_AUDIT_SECRET='+secrets.token_hex(32)+'\n');(root/'.env').chmod(0o600)
(root/'fault-control.json').write_text('{}\n')
for name in ['seed.mjs','io-faults.mjs','fault-control.json']:(root/name).chmod(0o644)
print('Prepared disposable runtime. Generated credentials stay private; do not commit runtime output.')
