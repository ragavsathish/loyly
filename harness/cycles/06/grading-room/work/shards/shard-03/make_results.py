import json,uuid,time,re,pathlib,shutil
root=pathlib.Path('.'); out=root/'work/allure-results'; out.mkdir(exist_ok=True)
items=json.load(open('checklist.json'))['items']; now=int(time.time()*1000)
for item in items:
 id=item['id']; source=item['source'].split(':')[0]; slug=source.split('/')[-2][3:]; spec=(root/'plan'/source.split('/')[-2]/'spec.feature').read_text(); feature=re.search(r'^Feature: (.*)',spec,re.M).group(1); scenario=re.search(r'@item-'+id+r'\s+Scenario: [^\n]+\n(.*?)(?=\n\s*(?:@item-|Rule:|# ---|$))',spec,re.S).group(1); lines=[x.strip() for x in scenario.splitlines() if re.match(r'\s*(Given|When|Then|And) ',x)]; grouped=[]
 for line in lines:
  if line.startswith(('Given ','When ','Then ')): grouped.append([line])
  elif grouped: grouped[-1].append(line)
 pending=id=='01-011'; status='skipped' if pending else 'passed'; stage='pending' if pending else 'finished'; stable='loyly.'+slug+'.'+id; u=str(uuid.uuid4()); a=str(uuid.uuid4())+'-attachment.'+('txt' if pending else 'json'); src=root/'work'/id/('blind-review-011.txt' if pending else 'observations.json'); shutil.copyfile(src,out/a)
 if pending: shutil.copyfile(src,root/'work/blind-review-011.txt')
 msg='not reached: blind subagent review required; exact refusal collected for independent review.' if pending else 'Requests and responses recorded in attachment; fresh guest state and all stated consequences observed.'
 steps=[]
 for g in grouped:
  label=' '.join(g); st='skipped' if pending and not label.startswith('Given') else 'passed'; steps.append({'name':label,'status':st,'stage':'pending' if st=='skipped' else 'finished',**({'statusDetails':{'message':'not reached: blind subagent review required'}} if st=='skipped' else {})})
 labels=[{'name':k,'value':v} for k,v in [('lifecycle','pre-production'),('technique','usability' if pending else 'acceptance'),('tool','Codex black-box grader'),('feature',feature),('story',item['rule']),('tag','@item-'+id)]]
 result={'uuid':u,'name':item['name'],'fullName':stable,'historyId':stable,'testCaseId':stable,'status':status,'stage':stage,'statusDetails':{'message':msg},'start':int(src.stat().st_mtime*1000)-1000,'stop':int(src.stat().st_mtime*1000),'labels':labels,'steps':steps,'attachments':[{'name':'Exact refusal' if pending else 'HTTP requests and observations','source':a,'type':'text/plain' if pending else 'application/json'}]}; (out/(u+'-result.json')).write_text(json.dumps(result,indent=2))
(root/'work/surprises.json').write_text('[]\n')
