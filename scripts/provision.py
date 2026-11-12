#!/usr/bin/env python3
"""Provision only an isolated, loopback-only disposable Folio instance."""
import argparse,json,os,secrets,subprocess
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('mode',choices=['before','after']);p.add_argument('--root',required=True);p.add_argument('--image',required=True);p.add_argument('--commit',required=True);a=p.parse_args()
r=Path(a.root).resolve();r.mkdir(parents=True,exist_ok=True)
project='folio-pr14-two-passages-'+a.mode+'-'+secrets.token_hex(3)
(r/'.env').write_text('FOLIO_EVIDENCE_SECRET='+secrets.token_urlsafe(40)+'\n');(r/'.env').chmod(0o600)
compose='''services:
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
  app:
    image: IMAGE
    cap_drop: ["ALL"]
    ports: ["127.0.0.1::4870"]
    depends_on:
      postgres: {condition: service_healthy}
      redis: {condition: service_started}
    volumes: ["data:/app/data"]
    environment:
      DATABASE_URL: postgres://folio@postgres:5432/folio
      REDIS_URL: redis://redis:6379
      FOLIO_SECRET: ${FOLIO_EVIDENCE_SECRET}
    command: ["node", "--import", "tsx", "server/index.ts"]
volumes:
  data:
'''.replace('IMAGE',a.image)
(r/'compose.yaml').write_text(compose)
args=['docker','compose','-p',project,'-f',str(r/'compose.yaml'),'--env-file',str(r/'.env')]
subprocess.run(args+['up','-d'],check=True,cwd=r)
container=subprocess.check_output(args+['ps','-q','app'],text=True,cwd=r).strip()
port=subprocess.check_output(['docker','port',container,'4870/tcp'],text=True).strip().split(':')[-1]
image=subprocess.check_output(['docker','inspect','--format','{{.Image}}',container],text=True).strip()
runtime={'mode':a.mode,'project':project,'base':'http://127.0.0.1:'+port,'appContainer':container,'image':image,'baseline':'94f4e0a6e9f83bd84f80ae097e47910242b7bd99','fixedCommit':'bef6512503ee4ea67de8a08ea528194e45dafc95','commit':a.commit}
(r/'runtime.json').write_text(json.dumps(runtime,indent=2)+'\n')
print('Disposable '+a.mode+' fixture ready at '+runtime['base'])
