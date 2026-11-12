from pathlib import Path
import subprocess,secrets,json,os,sys,socket
root=Path(__file__).resolve().parent
variant=sys.argv[1] if len(sys.argv)>1 else 'upstream'
assert variant in ['upstream','fork'];assert os.environ.get('FOLIO_SOURCE'),'Set FOLIO_SOURCE to the pinned checkout with npm dependencies'
assert not (root/'data').exists() and not (root/'fixture.private.json').exists(),'Use a fresh disposable runtime'
fork=variant=='fork';prefix='folio-retirement-fork' if fork else 'folio-retirement'
for name in [prefix+'-app',prefix+'-git']:
 assert subprocess.run(['docker','container','inspect',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode!=0,'Existing container: '+name
root.chmod(0o711)
for name in ['data','git-remotes']:(root/name).mkdir(mode=0o777);(root/name).chmod(0o777)
def free_port(start):
 while True:
  s=socket.socket()
  try:s.bind(('127.0.0.1',start));s.close();return start
  except OSError:s.close();start+=2
app=free_port(54900 if fork else 54898);git=free_port(54901 if fork else 54899)
commit='2e048814d1ea83fa6d3d03285d6e330b52a010e5' if fork else 'c5545fdfed40cf421bd44dc8716d71c3cd8b2f21'
image=os.environ.get('FOLIO_RETIREMENT_IMAGE','folio-retirement-app:'+('2e04881' if fork else 'c5545fd'))
runtime={'baseline':'94f4e0a6e9f83bd84f80ae097e47910242b7bd99','fixedCommit':commit,'image':image,'base':f'http://127.0.0.1:{app}','gitHost':f'http://127.0.0.1:{git}/shared.git','gitApp':'http://git-remote:8080/shared.git','appContainer':prefix+'-app','gitContainer':prefix+'-git','project':'folio-retirement-fork-control-20261112' if fork else 'folio-retirement-20261112','noFaultInjection':True}
(root/'runtime.json').write_text(json.dumps(runtime,indent=2)+'\n')
(root/'.env').write_text('FOLIO_AUDIT_SECRET='+secrets.token_hex(32)+'\n');(root/'.env').chmod(0o600)
(root/'git-http.mjs').chmod(0o644)
compose=f'''services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: folio
      POSTGRES_DB: folio
      POSTGRES_HOST_AUTH_METHOD: trust
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U folio"]
      interval: 2s
      timeout: 2s
      retries: 30
  redis:
    image: redis:7-alpine
    command: ["redis-server", "--save", "", "--appendonly", "no"]
  git-remote:
    image: folio-retirement-git-http:20261112
    cap_drop: ["ALL"]
    container_name: {prefix}-git
    ports: ["127.0.0.1:{git}:8080"]
    volumes: ["./:/audit:ro", "./git-remotes:/repos"]
    command: ["node", "/audit/git-http.mjs"]
  app:
    image: {image}
    cap_drop: ["ALL"]
    container_name: {prefix}-app
    ports: ["127.0.0.1:{app}:4870"]
    depends_on:
      postgres: {{condition: service_healthy}}
      redis: {{condition: service_started}}
    volumes: ["./data:/app/data", "./:/audit:ro"]
    environment:
      DATABASE_URL: postgres://folio@postgres:5432/folio
      REDIS_URL: redis://redis:6379
      FOLIO_SECRET: ${{FOLIO_AUDIT_SECRET}}
      PUBLIC_URL: http://127.0.0.1:{app}
    command: ["node", "--import", "tsx", "server/index.ts"]
'''
(root/'compose.yaml').write_text(compose)
print('Prepared',variant,'disposable runtime on loopback ports',app,git)
