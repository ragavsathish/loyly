import json,os,re,uuid,shutil
from pathlib import Path
items=json.load(open('checklist.json'))['items']; out=Path('work/allure-results');out.mkdir(exist_ok=True)
passed=set('01-001 01-002 01-003 01-004 01-005 01-006 01-007 01-008 01-009 01-010 02-001 02-002 02-004 02-005 02-006 02-007 02-009 02-010 03-001 03-002 03-003 03-004 03-005 03-014 03-006 03-010 03-011 04-001 04-002 04-003 04-005 04-006 05-001 05-002 05-003'.split())
reasons={'02-003':'the offer was created for a future date; passage beyond its end was not observable through the served controls','02-008':'the offer was created for a future date; passage to its start was not observable through the served controls','03-007':'the notice was created, but passage of the 14-day choose deadline was not observable through the served controls','03-008':'the notice was created, but passage of the choose deadline was not observable through the served controls','03-009':'the holding was selected, but passage of the 30-day lapse deadline was not observable through the served controls','03-012':'both claimants declined, but passage of the lapse deadline was not observable through the served controls','03-013':'the last queue entry was withdrawn, but passage to the lapse deadline was not observable through the served controls','04-004':'the future revision was recorded, but a decision after its effective date was not observed','04-007':'a future policy revision was recorded, but an earlier notice and a later notice under the revision were not established','05-004':'the uncapped house accepted the request, but no earlier family booking in that house was established to exercise the cap distinction','05-005':'a completed earlier occurrence was not established; the served interface did not expose a clock control'}
text=open('work/01-011/command.log').read(); row=next(json.loads(x) for x in text.splitlines() if x.startswith('{"method"'));blind=row['response']['message'];open('work/blind-review-011.txt','w').write(blind+'\n')
surprises=[]
for it in items:
 i=it['id'];spec=Path('plan')/it['source'].split('/')[2]/'spec.feature'; content=spec.read_text(); feature=re.search(r'^Feature: (.+)',content,re.M).group(1); section=content.split('@item-'+i,1)[1].split('@item-',1)[0]; lines=[]
 for line in section.splitlines():
  m=re.match(r'\s*(Given|When|Then|And) (.+)',line)
  if m: lines.append((m.group(1),m.group(2)))
 start,stop,code=json.load(open('work/'+i+'/timing.json')); status='skipped' if i=='01-011' else 'passed' if i in passed and code==0 else 'failed'; message=('not reached: blind subagent review required; exact closed-day refusal collected.' if i=='01-011' else 'not reached: '+reasons.get(i,'the necessary scenario or consequence was not observed') if status=='failed' else 'Observed the requests, responses, and resulting readings in the attached VM transcript.')
 records=[]
 for line in open('work/'+i+'/command.log'):
  if line.startswith('{"method"'):
   try: records.append(json.loads(line))
   except ValueError: pass
 if status=='passed':
  summary='; '.join(r['method']+' '+r['path']+' → '+str(r['status']) for r in records[-5:]); message=summary+'; checked the corresponding booking, policy, queue or derived-view consequence in the attached responses.'
 steps=[]; phase='Given'
 for k,v in lines:
  if k!='And': phase=k
  st='passed' if status=='passed' else ('passed' if phase=='Given' and i not in ['04-007','05-004','05-005'] else 'skipped')
  steps.append({'name':phase+': '+v,'status':st,'stage':'finished' if st=='passed' else 'pending','statusDetails':{'message': 'See attached request and response transcript.' if st=='passed' else 'not reached: '+reasons.get(i,'blind review required')}})
 uid=str(uuid.uuid4()); aid=str(uuid.uuid4())+'-attachment.txt'; source='work/blind-review-011.txt' if i=='01-011' else 'work/'+i+'/command.log';shutil.copyfile(source,out/aid)
 slug=it['source'].split('/')[2].split('-',1)[1];stable='loyly.'+slug+'.'+i
 labels=[{'name':k,'value':v} for k,v in [('lifecycle','pre-production'),('technique','usability' if i=='01-011' else 'acceptance'),('tool','Codex black-box grader'),('feature',feature),('story',it['rule']),('tag','@item-'+i)]]
 obj={'uuid':uid,'name':it['name'],'fullName':stable,'testCaseId':stable,'historyId':stable,'status':status,'stage':'pending' if i=='01-011' else 'finished','statusDetails':{'message':message},'start':start,'stop':stop,'labels':labels,'steps':steps,'attachments':[{'name':'Blind refusal' if i=='01-011' else 'VM command and HTTP observations','source':aid,'type':'text/plain'}]}
 (out/(uid+'-result.json')).write_text(json.dumps(obj,indent=2))
Path('work/surprises.json').write_text(json.dumps(surprises))
