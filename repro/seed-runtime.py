from pathlib import Path
import subprocess,json,hashlib,os
root=Path(__file__).parent
source=os.environ['FOLIO_SOURCE']
baseline='94f4e0a6e9f83bd84f80ae097e47910242b7bd99'
hashes={}
for path in ['server/collab.ts','server/proposals.ts','server/storage.ts','server/mcp.ts','server/routes.ts','shared/contracts.ts','package.json','package-lock.json']:
 actual=subprocess.check_output(['docker','exec','folio-recovery-audit-app','cat','/app/'+path])
 expected=subprocess.check_output(['git','-C',source,'show',baseline+':'+path])
 assert actual==expected,path
 hashes[path]=hashlib.sha256(actual).hexdigest()
r=subprocess.run(['docker','exec','folio-recovery-audit-app','node','--import','tsx','/audit/seed.mjs'],capture_output=True,text=True,timeout=60)
(root/'seed-stderr.private.log').write_text(r.stderr)
assert r.returncode==0,'Seed failed; inspect private seed log'
fixture=json.loads(r.stdout.strip().splitlines()[-1]);p=root/'fixture.private.json';p.write_text(json.dumps(fixture,indent=2)+'\n');p.chmod(0o600)
port=subprocess.check_output(['docker','port','folio-recovery-audit-20261112-postgres-1','5432'],text=True).strip().rsplit(':',1)[1]
(root/'runtime.json').write_text(json.dumps({'baseline':baseline,'base':'http://127.0.0.1:54897','appContainer':'folio-recovery-audit-app','postgresContainer':'folio-recovery-audit-20261112-postgres-1','postgresPort':int(port),'sourceHashes':hashes},indent=2)+'\n')
print('Seeded synthetic users, three test pages and a review space; critical runtime sources match pinned upstream')
