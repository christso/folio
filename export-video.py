import json,pathlib,subprocess,sys
root=pathlib.Path(__file__).resolve().parent
mode=sys.argv[1]
assert mode in ('before','after')
raw=root/mode/'capture.webm'
duration=float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',str(raw)],text=True))
captions=json.loads((root/(mode+'-captions.json')).read_text())
captions[1]['text']='The browser sentence is confirmed by HTTP MCP.\nThe agent reads this CURRENT body and revision.'
captions[2]['text']='MCP changes only Status, supplying the matching baseRevision.\nBoth changes are present. No stale write or injected scheduling.'
if mode=='after':
    # Align the Redo caption with the observed sentence-restoration frame.
    captions[4]['at']=30.0
captions[-1]['at']=duration
captions[-1]['text']='Separate reload and REST/MCP assertions passed (see receipt).\nFinal frame held for readability.'
def stamp(t):
    ms=round(t*1000)
    return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02},{ms%1000:03}'
srt=root/(mode+'-captions.srt')
srt.write_text(''.join(f'{i+1}\n{stamp(c["at"])} --> {stamp(captions[i+1]["at"] if i+1<len(captions) else duration+5)}\n{c["text"]}\n\n' for i,c in enumerate(captions)))
subprocess.run(['ffmpeg','-y','-i',str(raw),'-vf',f"fps=20,tpad=stop_mode=clone:stop_duration=5,pad=iw:ih+110:0:0:color=0x111827,subtitles={srt}:force_style='FontName=DejaVu Sans,Fontsize=10,PrimaryColour=&H00FFFFFF,Outline=1,Alignment=2,MarginV=6'",'-c:v','libx264','-preset','slow','-crf','30','-pix_fmt','yuv420p','-movflags','+faststart','-an',str(root/(mode+'.mp4'))],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
print(json.dumps({'mode':mode,'durationSeconds':duration+5,'bytes':(root/(mode+'.mp4')).stat().st_size}))
