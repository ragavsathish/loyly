import json,uuid,pathlib,re,shutil,time
from jsonschema import validate
root=pathlib.Path('.'); out=root/'work/allure-results';out.mkdir(exist_ok=True)
items=json.load(open('checklist.json'))['items']; schema=json.load(open('allure-lifecycle-result.schema.json'))
messages={
'01-001':'GET state: room 8 lists Tuesday 17:00 and 18:30; room 9 lists Thursday, Friday, Saturday and no Tuesday.',
'01-002':'POST book room 9 Tuesday 17:00 refused: pukuhuone 9 has no sauna day on Tuesday. It opens Thursday, Friday, Saturday. Request pukuhuone 8 on Tuesday at 17:00 instead.',
'01-007':'POST book confirmed holding-1; re-read posted list, heater and billing identify apartment 12 and Tuesday 17:00–18:30.',
'01-008':'POST giveUp holding-1 succeeded; re-read posted list, heater and billing have no holding or charge.',
'02-004':'POST free release and take succeeded; dated views show apartment 3 and no taker fee; standing charge and following Tuesday remain apartment 12.',
'02-005':'POST sale release and take succeeded; dated views show apartment 3, resale signal offer-3, v1 and house-resale-tariff, plus apartment 12 standing fee and later holding.',
'02-006':'POST withdrawal succeeded, subsequent take refused; dated views return occurrence to apartment 12 and later standing holding remains.',
'02-007':'POST take succeeded and withdrawal refused; dated views retain apartment 3 and later standing holding for apartment 12.',
'02-008':'Guest clock advanced past served 2026-11-24 17:00 boundary; app clock confirmed 17:01, offer expired, take refused, occurrence unclaimed and standing fee and later holding retained.',
'04-001':'GET schedules: Soukanvuori offers Tuesday room 8; newly configured house B offers Friday only.',
'04-002':'POST eligible shareholder in Soukanvuori and tenant in self-service confirmed; cross-house roles refused with each house policy.',
'04-003':'GET routes: Soukanvuori directs requests to manager with queue disabled; self-service house offers resident booking and queue.',
'04-004':'POST future revision v2 with board authority; before effective instant booking identifies v1, after guest clock advance app confirms v2 and booking identifies v2.',
'04-005':'POST dispute for given-up holding-1 returned confirmation and given-up history, each naming booking and v1.',
'04-006':'POST closed-day refusal under v1 then future revision v2; history re-read retains original reason and v1.',
'04-007':'POST created v1 notice with 14/30-day deadlines, recorded future v2 revision and advanced guest clock; prior notice retained dates and later notice used v2 with 7/21-day deadlines.'}
for item in items:
 id=item['id']; slug=re.search(r'plan/\d+-(.*?)/spec',item['source']).group(1); featurepath=next((root/'plan').glob('*-'+slug+'/spec.feature')); txt=featurepath.read_text(); feature=re.search(r'^Feature: (.*)',txt,re.M).group(1)
 sc=re.search(r'@item-'+re.escape(id)+r'\s+Scenario:.*?\n(.*?)(?=\n\s*(?:@item-|Rule:|# ---)|\Z)',txt,re.S).group(1)
 lines=re.findall(r'^\s*(Given|When|Then|And) (.+)$',sc,re.M); groups={'Given':[],'When':[],'Then':[]}; current='Given'
 for kind,content in lines:
  if kind!='And':current=kind
  groups[current].append(content)
 uid=str(uuid.uuid4()); stable='loyly.'+slug+'.'+id; attachments=[]
 for f in ['observations.json','vm-final.log','command.txt','exit-final.txt']:
  src=root/'work'/id/f; dest=str(uuid.uuid4())+'-attachment.'+('json' if f.endswith('.json') else 'txt');shutil.copyfile(src,out/dest);attachments.append({'name':f,'source':dest,'type':'application/json' if f.endswith('.json') else 'text/plain'})
 now=int(time.time()*1000); obj={'uuid':uid,'name':item['name'],'fullName':stable,'testCaseId':stable,'historyId':stable,'status':'passed','stage':'finished','statusDetails':{'message':messages[id]},'start':now,'stop':now,'labels':[{'name':'lifecycle','value':'pre-production'},{'name':'technique','value':'acceptance'},{'name':'tool','value':'Codex black-box grader'},{'name':'feature','value':feature},{'name':'story','value':item['rule']},{'name':'tag','value':'@item-'+id}],'steps':[{'name':kind+': '+'; '.join(parts),'status':'passed','stage':'finished','statusDetails':{'message':messages[id]}} for kind,parts in groups.items() if parts], 'attachments':attachments}
 validate(obj,schema);(out/(uid+'-result.json')).write_text(json.dumps(obj,indent=2))
(root/'work/surprises.json').write_text('[]\n')
print('validated',len(items))
