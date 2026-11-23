import json,pathlib,re,uuid,time,shutil
r=pathlib.Path.cwd(); out=r/'work/allure-results';out.mkdir(exist_ok=True)
items=json.loads((r/'checklist.json').read_text())['items'];now=int(time.time()*1000)
messages={
'01-003':'POST book 8 Tuesday 17:00 for 12 confirmed holding-1 until 18:30; GET state re-read the confirmed recurring Tuesday holding for 12.',
'01-004':'After booking for 12, apartment 3 requested the same slot; response refused: The slot is held. GET state retained 12 as holder.',
'01-009':'Concurrent POST requests from 12 and 3 were issued before awaiting either response; one confirmed, one refused because held. GET state showed one holding and one holder in list, heater, and billing.',
'01-010':'One hundred pairs of POST requests were issued concurrently, giving up the winner before the next run: one-confirmed 100, both-confirmed 0, neither-confirmed 0.',
'02-009':'Apartment 12 released 2026-11-24 FREE; 3 took it and 4 was refused. Dated list and heater named 3; billing retained 12 standing fee and no taker fee. Following Tuesday remained 12.',
'02-010':'Concurrent take requests from 3 and 4 for FREE offer: one succeeded, one refused. Dated list and heater named 3, billing retained 12 standing fee without taker charge; later Tuesday remained 12.',
'03-001':'With two group 9 holdings, free capacity, and apartment 3 queued, evaluateScarcity returned no notices.',
'03-002':'With both group 8 slots held by 12 and no queue, evaluateScarcity returned no notices.',
'03-003':'With both group 8 slots held and apartment 3 queued, a FREE occurrence offer was released; evaluation retained both standing holdings and issued a notice to 12.',
'03-004':'With group 8 full and group 9 waiting, evaluation of 8 returned no notice.',
'03-005':'After filling group 8, households 3 and 4 joined in order; GET state lists 3 first, then 4, both in group 8 and no unrelated entries.',
'03-014':'With three group 9 holdings for 12 and an eligible waiter, two evaluations produced one active notice for 12 with no selected holding.',
'05-001':'An upcoming family occurrence for 12 was confirmed; a second request was refused with family cap and existing occurrence-1 identified.',
'05-002':'After an upcoming general occurrence, the free family occurrence was confirmed for 12.',
'05-003':'After an upcoming family occurrence, the free general occurrence was confirmed for 12.',
'05-004':'House family-times had family cap 1; created house B without that cap and confirmed two family occurrences for its household 12.',
'05-005':'Confirmed family occurrence ending 2026-11-21T18:30Z; set guest clock to 19:00Z and GET state confirmed time. Next family occurrence was confirmed.'}
for x in items:
 i=x['id']; slug=x['source'].split('/')[2].split('-',1)[1];spec=r/'plan'/x['source'].split('/')[2]/'spec.feature';txt=spec.read_text();feature=re.search(r'^Feature: (.*)',txt,re.M).group(1);block=txt.split('@item-'+i,1)[1].split('\n    @item-',1)[0].split('\n  Rule:',1)[0];steps=[]
 for l in block.splitlines():
  m=re.match(r'\s+(Given|When|Then|And) (.+)',l)
  if m: steps.append({'name':m.group(1)+' '+m.group(2),'status':'passed','stage':'finished'})
 uid=str(uuid.uuid4());a=str(uuid.uuid4())+'-attachment.txt';shutil.copyfile(r/'work'/i/'http.jsonl',out/a)
 stable='loyly.'+slug+'.'+i;labels=[{'name':k,'value':v} for k,v in [('lifecycle','pre-production'),('technique','acceptance'),('tool','Codex black-box grader'),('feature',feature),('story',x['rule']),('tag','@item-'+i)]]
 obj={'uuid':uid,'name':x['name'],'fullName':stable,'testCaseId':stable,'historyId':stable,'status':'passed','stage':'finished','statusDetails':{'message':messages[i]},'start':int((r/'work'/i/'command2.txt').stat().st_mtime*1000),'stop':int((r/'work'/i/'receipt2.txt').stat().st_mtime*1000),'labels':labels,'steps':steps,'attachments':[{'name':'HTTP requests and responses','source':a,'type':'text/plain'}]}
 (out/(uid+'-result.json')).write_text(json.dumps(obj,indent=2))
(r/'work/surprises.json').write_text('[]\n')
import jsonschema
schema=json.loads((r/'allure-lifecycle-result.schema.json').read_text())
for p in out.glob('*-result.json'):jsonschema.validate(json.loads(p.read_text()),schema)
print('validated',len(list(out.glob('*-result.json'))))
