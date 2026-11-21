import json,os,subprocess,concurrent.futures,time,shutil
room=os.getcwd(); items=json.load(open('checklist.json'))['items']; image='/Users/sathish.narayanan/Documents/git/loyly-pi-whole-app/.pi/harness/.state/assets/builder-clojure'
def run(item):
 i=item['id']; d=f'{room}/work/{i}';os.makedirs(d,exist_ok=True);shutil.copy('work/probe.js',d+'/probe.js');script=f'''apk add --no-cache nodejs icu-data-full; node --version; cp -R /candidate /tmp/app; cd /tmp/app; ./start.sh 8080 >/out/server.log 2>&1 & p=$!; trap "kill $p 2>/dev/null; wait $p 2>/dev/null" EXIT; for i in $(seq 1 30); do curl -fsS http://127.0.0.1:8080/api >/dev/null && break; kill -0 $p 2>/dev/null || exit 1; sleep 1; done; node /out/probe.js {i}''';cmd=['gondolin','exec','--image',image,'--mount-hostfs',f'{room}/impl:/candidate:ro','--mount-hostfs',f'{d}:/out','--','sh','-c',script];start=int(time.time()*1000)
 try:
  p=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=180); output=p.stdout; code=p.returncode
 except subprocess.TimeoutExpired as e: output=str(e);code=124
 stop=int(time.time()*1000);open(d+'/command.log','w').write('COMMAND '+repr(cmd)+'\n'+output+'\nEXIT '+str(code)+'\n');open(d+'/timing.json','w').write(json.dumps([start,stop,code]));return i,code
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
 for x in pool.map(run,items):print(x,flush=True)
