import json,uuid,re,time,pathlib,shutil
root=pathlib.Path('.'); items=json.loads((root/'checklist.json').read_text())['items']; out=root/'work/allure-results'; now=int(time.time()*1000)
notes={'01-003':'Confirmed b1 17:00–18:30 for apartment 12; state records standing and dated view shows holder.', '01-004':'Apartment 3 refused: This slot is held. State retains apartment 12 as confirmed.', '01-009':'Two concurrent requests yielded one confirmed and one refused as held; state and three views show one holder.', '01-010':'100 concurrent pairs were sent, releasing the confirmed holding between runs; counts recalculated from actual status fields in the recorded responses.', '02-009':'FREE release taken by apartment 3; apartment 4 refused; posted and heater identify 3, billing charges only standing holder 12, and next Tuesday remains with 12.', '02-010':'Concurrent taker requests yielded one taken and one refusal; posted and heater show apartment 3, billing shows holder 12 standing fee, next Tuesday remains 12.', '03-002':'All three group 8 slots held, household 12 holds two, no queue; scarcity returns no notices.', '03-001':'not reached: the requested waiting household was refused by the default manager-mediated house; scarcity returned no notices without the required queue.', '03-003':'not reached: default house refused the waiting household, so the required full group with a waiting household was not established.', '03-004':'not reached: default house refused the group B waiting request, so the required cross-group queue was not established.', '03-005':'not reached: both queue requests were refused by the manager-mediated house; no queue ordering could be observed.', '03-014':'not reached: the waiting request was refused and the attempted third holding was already occupied; repeat-notice condition was not established.', '05-001':'not reached: the available default house has only general time classes and no family cap; the requested family-time setup was not established.', '05-002':'not reached: no family-time class or cap was configured in the observed default house.', '05-003':'not reached: no family-time class or cap was configured in the observed default house.', '05-004':'not reached: two houses with the specified distinct policies were not established.', '05-005':'not reached: no family-time occurrence or cap was established, and no deadline clock was advanced.'}
# Recover the real race counts; script initially counted the wrong JSON shape.
p=root/'work/01-010/command.log'; records=[]
for line in p.read_text().splitlines():
 try:
  x=json.loads(line)
  if x.get('path')=='/api/bookings':records.append(json.loads(x['response']).get('status'))
 except:pass
counts={'one':0,'both':0,'neither':0}
for i in range(0,len(records),2):
 n=records[i:i+2].count('confirmed'); counts['one' if n==1 else 'both' if n==2 else 'neither']+=1
(root/'work/01-010/race-counts.json').write_text(json.dumps({'counts':counts,'note':'Recomputed from recorded response status; original script counts used an incorrect response shape.'},indent=2))
notes['01-010'] += ' Recomputed counts: '+json.dumps(counts)
passids={'01-003','01-004','01-009','02-009','02-010','03-002'}
if counts=={'one':100,'both':0,'neither':0}:passids.add('01-010')
for it in items:
 id=it['id']; slug=it['source'].split('/')[2][3:]; spec=(root/'plan'/it['source'].split('/')[2]/'spec.feature').read_text(); feature=re.search(r'^Feature: (.*)',spec,re.M).group(1); match=re.search(r'@item-'+id+r'\n\s*Scenario:.*?\n(.*?)(?=\n\s*(?:@item-|Rule:|# -)|\Z)',spec,re.S); lines=[x.strip() for x in match.group(1).splitlines() if re.match(r'\s*(Given|When|Then|And) ',x)]; status='passed' if id in passids else 'failed'; uid=str(uuid.uuid4()); attachment=str(uuid.uuid4())+'-attachment.txt'; shutil.copyfile(root/'work'/id/'command.log',out/attachment); st=[]; phase='Given'
 for line in lines:
  if line.startswith(('Given ','When ','Then ')): phase=line.split()[0]
  reached=status=='passed' or (phase=='Given' and id.startswith('03'))
  st.append({'name':phase+': '+line,'status':'passed' if reached else 'failed','stage':'finished','statusDetails':{'message': notes[id] if reached else 'not reached: required scenario setup or consequence not established; see attached observations.'}})
 full=f'loyly.{slug}.{id}'; result={'uuid':uid,'name':it['name'],'fullName':full,'testCaseId':full,'historyId':full,'status':status,'stage':'finished','statusDetails':{'message':notes[id]},'start':now-120000,'stop':now,'labels':[{'name':k,'value':v} for k,v in [('lifecycle','pre-production'),('technique','acceptance'),('tool','Codex black-box grader'),('feature',feature),('story',it['rule']),('tag','@item-'+id)]],'steps':st,'attachments':[{'name':'VM command and HTTP observations','source':attachment,'type':'text/plain'}]}; (out/(uid+'-result.json')).write_text(json.dumps(result,indent=2))
(root/'work/surprises.json').write_text(json.dumps([{'item':'01-010','observation':'Initial in-script race counts interpreted the response shape incorrectly; corrected counts were computed from the recorded responses.','evidence_file':'work/01-010/race-counts.json'}],indent=2))
print(counts, len(items))
try:
 import jsonschema
 schema=json.loads((root/'allure-lifecycle-result.schema.json').read_text())
 for p in out.glob('*-result.json'):jsonschema.validate(json.loads(p.read_text()),schema)
 print('all schema valid')
except ImportError: print('jsonschema unavailable')
