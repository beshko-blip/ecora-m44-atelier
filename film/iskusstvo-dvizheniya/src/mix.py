# Субтитры (ASS для прожига + SRT) и аудиомикс: голос + музыка с ducking.
import json, subprocess, os
HERE = os.path.dirname(os.path.abspath(__file__))
TL = json.load(open(HERE + '/timeline.json'))
cues, total = TL['cues'], TL['total']

def ts_ass(t):
    h = int(t // 3600); m = int(t % 3600 // 60); s = t % 60
    return f'{h}:{m:02d}:{s:05.2f}'

def ts_srt(t):
    ms = int(round(t * 1000)); h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000)
    return f'{h:02d}:{m:02d}:{s:02d},{ms:03d}'

def wrap(txt, n=58):
    if len(txt) <= n: return txt
    words = txt.split(' '); best = None
    for i in range(1, len(words)):
        a, b = ' '.join(words[:i]), ' '.join(words[i:])
        sc = max(len(a), len(b))
        if best is None or sc < best[0]: best = (sc, a, b)
    return best[1] + '\n' + best[2]

ass = ['[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1920', 'PlayResY: 1080', 'WrapStyle: 2',
       'ScaledBorderAndShadow: yes', '', '[V4+ Styles]',
       'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
       'Style: Light,Montserrat,38,&H001E1E1E,&H001E1E1E,&H30ECF2F5,&H00000000,0,0,0,0,100,100,0.4,0,1,3,0,2,200,200,58,204',
       'Style: Dark,Montserrat,38,&H00F0F0F0,&H00F0F0F0,&H600E0E0E,&H00000000,0,0,0,0,100,100,0.4,0,1,3,0,2,200,200,58,204',
       '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text']
srt = []
for i, c in enumerate(cues):
    st = 'Dark' if c['scene'] == 'open' else 'Light'
    a, b = c['start'], c['end'] + 0.25
    txt = wrap(c['text'])
    ass.append(f"Dialogue: 0,{ts_ass(a)},{ts_ass(b)},{st},,0,0,0,,{{\\fad(150,150)}}" + txt.replace('\n', '\\N'))
    srt += [str(i + 1), f'{ts_srt(a)} --> {ts_srt(b)}', txt, '']
os.makedirs(HERE + '/out', exist_ok=True)
open(HERE + '/out/subs.ass', 'w').write('\n'.join(ass) + '\n')
open(HERE + '/out/ECORA_Iskusstvo_dvizheniya_RU.srt', 'w').write('\n'.join(srt))

# Голосовая дорожка: каждая реплика на своём месте таймлайна
inputs, filt = [], []
for i, c in enumerate(cues):
    inputs += ['-i', HERE + '/' + c['wav']]
    d = int(round(c['start'] * 1000))
    filt.append(f'[{i}:a]aresample=48000,aformat=channel_layouts=mono,adelay={d}|{d}[v{i}]')
n = len(cues)
filt.append(''.join(f'[v{i}]' for i in range(n)) + f'amix=inputs={n}:normalize=0:duration=longest,apad,atrim=0:{total:.3f}[vo]')
filt.append('[vo]highpass=f=70,acompressor=threshold=-20dB:ratio=2.5:attack=8:release=120,loudnorm=I=-16:TP=-2:LRA=7,aresample=48000[vox]')
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', *inputs, '-filter_complex', ';'.join(filt), '-map', '[vox]',
                '-ac', '1', HERE + '/out/vo.wav'], check=True)
# Музыка: начало трека ECORA, громкость сильно ниже голоса, ducking по голосу
mf = (f"[0:a]atrim=0:{total + 0.5:.3f},asetpts=PTS-STARTPTS,aresample=48000,volume=-17dB,"
      f"afade=t=in:d=2.5,afade=t=out:st={total - 4:.3f}:d=4[m];"
      f"[1:a]aformat=channel_layouts=stereo,asplit=2[sc][v];"
      f"[m][sc]sidechaincompress=threshold=0.03:ratio=4:attack=40:release=600:makeup=1[md];"
      f"[md][v]amix=inputs=2:normalize=0:weights=1 1,atrim=0:{total:.3f},alimiter=limit=0.89[a]")
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', '/home/user/ecora-m44-atelier/music/ecora.m4a',
                '-i', HERE + '/out/vo.wav', '-filter_complex', mf, '-map', '[a]', '-c:a', 'pcm_s16le',
                HERE + '/out/mix.wav'], check=True)
print('mix ok', total)
