from pathlib import Path
import subprocess,json,textwrap,hashlib
root=Path(__file__).parent
plans={
'snapshot-control':(1.0,[(0,'UPSTREAM 94f4e0a6e9f8 | CONTROL: baseline exists once; collaborative snapshot saved.'),(4,'Browser disconnected; disposable app stopped. Type an offline addition.'),(18,'Restart disposable app and reconnect with NO storage fault.'),(24,'CONTROL: original text and offline addition each appear once. Real readbacks agree.')], 'Result screenshot held. Baseline and edit each once. Reload, REST, HTTP MCP and file assertions passed.'),
'snapshot-fault':(1.0,[(0,'UPSTREAM 94f4e0a6e9f8 | FAULT TEST: baseline exists once; snapshot saved.'),(4,'Browser disconnected; disposable app stopped. Type an offline addition.'),(18,'Restart; inject ONE cancelled snapshot SELECT. No snapshot deleted. Release scheduling lock.'),(24,'CONFIRMED: original text duplicated; offline addition once. REST, MCP and file agree.')], 'Result screenshot held. Baseline duplicated. Reload retained this result (assertion receipt).'),
'proposal-control':(2.0,[(0,'UPSTREAM 94f4e0a6e9f8 | CONTROL: one new-page proposal submitted over real HTTP MCP.'),(4.7,'Click Accept with NO injected failure. Proposal leaves review queue.')], 'Actual screenshot after reload, held. ONE complete page. REST, HTTP MCP and file agree; successful accept replay returns 409.'),
'proposal-fault':(1.5,[(0,'UPSTREAM 94f4e0a6e9f8 | One real MCP new-page proposal; reviewer opens Accept.'),(3,'Inject ONE body rename EIO. Title-only page creation is allowed. Click Accept.'),(6,'Real UI error. Proposal pending; first heading-only file already exists (readback asserted).'),(11,'Clear the one-shot fault. Click Accept again on the SAME pending proposal.'),(14,'Retry creates proposal-retry-evidence-2.md beside the heading-only original.')], 'Actual screenshot after reload, held. TWO files from one proposal; REST, MCP and file receipts confirm each body.'),
'durability-control':(1.1,[(0,'UPSTREAM 94f4e0a6e9f8 | CONTROL: baseline file and snapshot exist. No save faults.'),(3,'Type browser edit. Current file saves it; browser recovery database exists.'),(9,'Navigate through the real sidebar. Local recovery copy is cleared after normal save.'),(13,'Crash ONLY disposable app with SIGKILL; restart and reopen the tested page.')], 'Actual reopened-page screenshot, held. CONTROL edit retained after crash. Browser, REST, HTTP MCP and file agree.'),
'durability-fault':(1.1,[(0,'UPSTREAM 94f4e0a6e9f8 | FAULT TEST: baseline file and snapshot exist.'),(2,'Inject TWO page-scoped save failures: file rename EIO AND snapshot write rejection.'),(6,'Browser + live REST contain edit. File and stored snapshot unchanged (asserted).'),(11,'Navigate via sidebar. Browser recovery database DELETED despite both failed saves (asserted).'),(15,'SIGKILL ONLY disposable app. Clear faults after memory is gone, then restart/reopen.')], 'Actual reopened-page screenshot, held. Edit LOST. REST, HTTP MCP and file show baseline. Requires BOTH save failures plus crash.'),
}
font='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
manifest={}
for name,(speed,captions,final) in plans.items():
 case=root/name
 duration=float(json.loads(subprocess.check_output(['ffprobe','-v','quiet','-show_format','-of','json',str(case/'capture.webm')]))['format']['duration'])*speed
 filters=[]
 def draw(text,prefix,begin=None,end=None):
  parts=[]
  for i,line in enumerate(textwrap.wrap(text,104)):
   p=case/(prefix+f'-{i}.txt');p.write_text(line)
   f=f"drawtext=fontfile={font}:textfile={p}:fontcolor=white:fontsize=20:x=20:y={736+i*26}"
   if begin is not None:f+=f":enable='between(t,{begin:.3f},{end:.3f})'"
   parts.append(f)
  return ','.join(parts)
 f0=f'[0:v]setpts={speed}*(PTS-STARTPTS),fps=20,pad=1280:832:0:0:color=0x0b1220'
 for i,(begin,text) in enumerate(captions):
  end=captions[i+1][0] if i+1<len(captions) else duration
  f0+=','+draw(text,'caption-'+str(i),begin,end)
 f0+=',setsar=1,format=yuv420p[raw]'
 f1='[1:v]fps=20,trim=duration=9,setpts=PTS-STARTPTS,pad=1280:832:0:0:color=0x0b1220,'+draw(final,'final')+',setsar=1,format=yuv420p[held]'
 vf=f0+';'+f1+';[raw][held]concat=n=2:v=1:a=0[out]'
 (case/'export-timeline.json').write_text(json.dumps({'speed':speed,'captions':captions,'heldScreenshotCaption':final,'heldSeconds':9,'note':'Real recorded UI followed by actual result.png held for readability. Holds and speed changes are editorial; SQL/IndexedDB/REST/MCP assertions are in receipt, not simulated UI.'},indent=2)+'\n')
 subprocess.run(['ffmpeg','-v','error','-y','-i',str(case/'capture.webm'),'-loop','1','-i',str(case/'result.png'),'-filter_complex',vf,'-map','[out]','-an','-c:v','libx264','-preset','fast','-crf','30','-pix_fmt','yuv420p','-movflags','+faststart',str(case/(name+'.mp4'))],check=True)
 p=case/(name+'.mp4');manifest[name]={'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'rawSha256':hashlib.sha256((case/'capture.webm').read_bytes()).hexdigest(),'resultScreenshotSha256':hashlib.sha256((case/'result.png').read_bytes()).hexdigest()}
 print(name,manifest[name]['bytes'])
(root/'video-hashes.json').write_text(json.dumps(manifest,indent=2)+'\n')
