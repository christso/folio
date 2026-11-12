#!/usr/bin/env python3
from pathlib import Path
import argparse,json,subprocess,textwrap,hashlib
p=argparse.ArgumentParser();p.add_argument('root');a=p.parse_args();root=Path(a.root).resolve();out=root/'exports';out.mkdir(exist_ok=True)
font='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';hashes={}
for mode in ['before','after']:
 case=root/mode/'capture';duration=float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',str(case/'capture.webm')],text=True))
 captions=json.loads((case/'captions.json').read_text());offset=captions[0]['at'];captions=[{**x,'at':max(0,x['at']-offset)} for x in captions if x['at']-offset<duration-.25]
 def draw(text,prefix,begin=None,end=None):
  filters=[]
  lines=[]
  for paragraph in text.splitlines():lines+=textwrap.wrap(paragraph,106)
  for i,line in enumerate(lines):
   file=out/(mode+'-'+prefix+str(i)+'.txt');file.write_text(line)
   f=f'drawtext=fontfile={font}:textfile={file}:fontcolor=white:fontsize=20:x=20:y={736+i*26}'
   if begin is not None:f+=f":enable='between(t,{begin:.3f},{end:.3f})'"
   filters.append(f)
  return ','.join(filters)
 vf='[0:v]setpts=PTS-STARTPTS,fps=20,pad=1280:832:0:0:color=0x0b1220'
 for i,c in enumerate(captions):vf+=','+draw(c['text'],'caption'+str(i)+'-',c['at'],captions[i+1]['at'] if i+1<len(captions) else duration)
 final='Actual result screenshot held for readability. Reload, REST, MCP and current Markdown file agree.\n'+('BEFORE: Undo left the browser sentence in place.' if mode=='before' else 'AFTER: Undo removed only the browser sentence; Redo restored it. Both agent changes remained.')
 vf+=',setsar=1,format=yuv420p[raw];[1:v]fps=20,trim=duration=6,setpts=PTS-STARTPTS,pad=1280:832:0:0:color=0x0b1220,'+draw(final,'result-')+',setsar=1,format=yuv420p[held];[raw][held]concat=n=2:v=1:a=0[video]'
 dest=out/(mode+'.mp4')
 subprocess.run(['ffmpeg','-v','error','-y','-i',str(case/'capture.webm'),'-loop','1','-i',str(case/'result.png'),'-filter_complex',vf,'-map','[video]','-an','-c:v','libx264','-preset','fast','-crf','30','-pix_fmt','yuv420p','-movflags','+faststart',str(dest)],check=True)
 subprocess.run(['ffmpeg','-v','error','-i',str(dest),'-f','null','-'],check=True)
 timeline={'rawSeconds':duration,'speed':1,'captionClockOffsetSeconds':offset,'captions':captions,'heldResultScreenshotSeconds':6,'heldCaption':final,'note':'Real browser automation capture. Final still is the actual post-reload screenshot, labelled as held. API assertions are in the receipt.'}
 (out/(mode+'-timeline.json')).write_text(json.dumps(timeline,indent=2)+'\n')
 hashes[mode]={'bytes':dest.stat().st_size,'sha256':hashlib.sha256(dest.read_bytes()).hexdigest(),'rawSha256':hashlib.sha256((case/'capture.webm').read_bytes()).hexdigest(),'resultScreenshotSha256':hashlib.sha256((case/'result.png').read_bytes()).hexdigest()}
 print(mode,dest.stat().st_size,flush=True)
(out/'video-hashes.json').write_text(json.dumps(hashes,indent=2)+'\n')
