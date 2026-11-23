import subprocess, pathlib, concurrent.futures, json
room=pathlib.Path.cwd(); image='/Users/sathish.narayanan/Documents/git/loyly-pi-whole-app/.pi/harness/.state/assets/builder-clojure'
items=json.loads((room/'checklist.json').read_text())['items']
def run(item):
 i=item['id']; d=room/'work'/i; d.mkdir(exist_ok=True)
 guest='''set -x
cp -R /candidate /tmp/app || exit 10
cd /tmp/app || exit 11
command -v node || true
./start.sh 18080 > /result/server.log 2>&1 & p=$!
for i in $(seq 1 30); do
 if curl -sS -D /result/headers.txt http://127.0.0.1:18080/ -o /result/root.txt; then break; fi
 if ! kill -0 "$p" 2>/dev/null; then break; fi
 sleep 1
done
cat /result/server.log
if test -s /result/root.txt; then cat /result/headers.txt /result/root.txt; else echo 'not reached: HTTP readiness'; fi
kill "$p" 2>/dev/null || true
wait "$p" 2>/dev/null || true
'''
 cmd=['gondolin','exec','--image',image,'--mount-hostfs',str(room/'impl')+':/candidate:ro','--mount-hostfs',str(d)+':/result','--','sh','-c',guest]
 import shlex
 (d/'command.txt').write_text(shlex.join(cmd)+'\n')
 try:
  p=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=120)
  out=p.stdout+'\nVM exit='+str(p.returncode)+'\n'
 except subprocess.TimeoutExpired as e: out=str(e.stdout)+'\nVM timeout\n'
 (d/'receipt.txt').write_text(out)
 return i,out[-500:]
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
 for i,out in pool.map(run,items): print(i,out,flush=True)
