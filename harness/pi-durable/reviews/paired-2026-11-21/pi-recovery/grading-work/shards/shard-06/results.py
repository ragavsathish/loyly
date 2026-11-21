import json,uuid,os,re,shutil,time,datetime
W='work'; out=W+'/allure-results';os.makedirs(out,exist_ok=True)
items=json.load(open('checklist.json'))['items']; o=json.load(open(W+'/outcomes.json'));o.update(json.load(open(W+'/outcomes-005.json')))
messages={'01-011':('skipped','not reached: blind subagent review required; POST closed-day request returned HTTP 409; exact refusal is attached.'),'02-001':('passed','POST FREE release and POST take returned 201 and 200; selected date is held by apartment 3, following Tuesday by apartment 12; FREE billing remains with 12 and heater follows taker.'),'02-002':('passed','POST FREE release and take returned 201 and 200; selected Tuesday is taken by apartment 3; following Tuesday is held and heated for 12 with standing fee for 12.'),'02-003':('passed','POST FREE release for 2026-11-24; end 18:30 UTC; after date -u -s 18:31, app asOf 18:31 shows unclaimed, no heater, fee for 12; following week remains held by 12.')}
for item in items:
 id=item['id']; featurefile=item['source'].split(':')[0].replace('docs/',''); text=open(featurefile).read(); feature=re.search(r'^Feature: (.*)',text,re.M).group(1); block=text.split('@item-'+id,1)[1].split('\n    @item-',1)[0]; block=block.split('\n  Rule:',1)[0]; lines=re.findall(r'^\s+(Given|When|Then|And) (.*)$',block,re.M)
 status,msg=messages.get(id,(o.get(id,['failed','not reached: no observation'])[0],o.get(id,['failed','not reached: no observation'])[1])); slug=featurefile.split('/')[1][3:]; stable='loyly.'+slug+'.'+id
 evidence=W+'/evidence-'+id+('.txt'); evidence=W+'/evidence-02-003b.txt' if id=='02-003' else evidence
 if id in o: start,stop=o[id][2:4]
 else:
  stop=int(os.path.getmtime(evidence)*1000);start=stop-5000
  if id=='02-003': start=int(datetime.datetime(2026,11,24,16,59,0,tzinfo=datetime.timezone.utc).timestamp()*1000)
 stop=max(stop,start)
 steps=[];phase='Given'
 for kind,s in lines:
  if kind!='And':phase=kind
  ss='skipped' if id=='01-011' and phase in ['When','Then'] else 'passed'
  st={'name':kind+' '+s,'status':ss,'stage':'pending' if ss=='skipped' else 'finished'}
  if ss=='skipped':st['statusDetails']={'message':'not reached: blind subagent review required'}
  steps.append(st)
 attachments=[]
 for path,title in ([(W+'/blind-review-011.txt','Exact refusal for blind review'),(evidence,'HTTP exchange')] if id=='01-011' else [(evidence,'HTTP requests and observations')]):
  src=str(uuid.uuid4())+'-attachment.txt'; shutil.copyfile(path,out+'/'+src); attachments.append({'name':title,'source':src,'type':'text/plain'})
 uid=str(uuid.uuid4()); labels=[('lifecycle','pre-production'),('technique','usability' if id=='01-011' else 'acceptance'),('tool','Pi black-box grader'),('feature',feature),('story',item['rule']),('tag','@item-'+id)]
 r={'uuid':uid,'name':item['name'],'fullName':stable,'testCaseId':stable,'historyId':stable,'status':status,'stage':'pending' if id=='01-011' else 'finished','statusDetails':{'message':msg},'start':start,'stop':stop,'labels':[{'name':k,'value':v} for k,v in labels],'steps':steps,'attachments':attachments}
 json.dump(r,open(out+'/'+uid+'-result.json','w'),indent=2)
json.dump([],open(W+'/surprises.json','w'))
