import json,subprocess,wave,sys
S=json.load(open('script.json'))
out=[]
for si,s in enumerate(S):
  for li,(tts,sub) in enumerate(s['lines']):
    fn=f'vo/{si:02d}_{li}.wav'
    subprocess.run([sys.executable,'-m','piper','-m','voices/ru_RU-dmitri-medium.onnx','-f',fn,'--length-scale','1.12','--sentence-silence','0.35'],input=tts.encode(),check=True,capture_output=True)
    w=wave.open(fn); d=w.getnframes()/w.getframerate(); out.append((fn,round(d,2),sub))
    print(fn,round(d,2))
json.dump(out,open('vo/durations.json','w'),ensure_ascii=False,indent=1)
print('total',sum(o[1] for o in out))
