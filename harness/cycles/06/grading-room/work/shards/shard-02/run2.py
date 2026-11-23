import subprocess,pathlib,concurrent.futures,json,shlex
r=pathlib.Path.cwd(); image='/Users/sathish.narayanan/Documents/git/loyly-pi-whole-app/.pi/harness/.state/assets/builder-clojure'; items=json.loads((r/'checklist.json').read_text())['items']
def run(x):
 i=x['id'];d=r/'work'/i;d.mkdir(exist_ok=True);(d/'probe.js').write_bytes((r/'work/probe.js').read_bytes())
 guest='''set -x
apk add nodejs || exit 10
date -u -s 2026-11-20T12:00:00Z || exit 11
cp -R /candidate /tmp/app || exit 12
cd /tmp/app || exit 13
./start.sh 18080 > /result/server.log 2>&1 & p=$!
trap 'kill "$p" 2>/dev/null; wait "$p" 2>/dev/null' EXIT
for i in $(seq 1 30); do curl -fsS http://127.0.0.1:18080/ -o /result/root.html && break; sleep 1; done
node /result/probe.js ITEM > /result/http.jsonl 2>&1
'''.replace('ITEM',i)
 cmd=['gondolin','exec','--image',image,'--mount-hostfs',str(r/'impl')+':/candidate:ro','--mount-hostfs',str(d)+':/result','--','sh','-c',guest];(d/'command2.txt').write_text(shlex.join(cmd)+'\n')
 try:
  p=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=180);out=p.stdout+'\nVM exit='+str(p.returncode)+'\n'
 except subprocess.TimeoutExpired as e:out=str(e.stdout)+'\nVM timeout\n'
 (d/'receipt2.txt').write_text(out);return i+' '+out[-100:]
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as p:
 for out in p.map(run,items):print(out,flush=True)
