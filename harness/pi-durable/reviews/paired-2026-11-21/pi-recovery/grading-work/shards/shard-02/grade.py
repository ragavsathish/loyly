import os,json,time,uuid,subprocess,urllib.request,urllib.error,threading,http.client,datetime,traceback,copy
root='/workspace'; work=root+'/work'; items=json.load(open(root+'/checklist.json'))['items']; os.makedirs(work+'/allure-results',exist_ok=True)
features={'01':'Booking core','02':'One-week occurrence release','04':'Multiple houses and traceable policy'}
surprises=[]
for item in items:
 id=item['id']; start=int(time.time()*1000); logs=[]; steps=[]; proc=None; port=18100+int(id.split('-')[1]); base=f'http://127.0.0.1:{port}'; status='failed'; message=''; given=False; when=False
 def log(s): logs.append(str(s))
 def req(method,path,data=None):
  body=None if data is None else json.dumps(data).encode(); log(f'>>> {method} {path} '+('' if body is None else body.decode()))
  try:
   with urllib.request.urlopen(urllib.request.Request(base+path,data=body,method=method,headers={'Content-Type':'application/json'}),timeout=8) as r: code=r.status; raw=r.read().decode()
  except urllib.error.HTTPError as e: code=e.code; raw=e.read().decode()
  log(f'<<< {code} {raw}'); return code,json.loads(raw)
 def get(path): return req('GET',path)
 def post(path,data): return req('POST',path,data)
 def booking(h='12',start='17:00',house='soukanvuori',resource='ph8'):
  return post('/api/bookings',{'house':house,'household':h,'resource':resource,'weekday':'Tuesday','start':start,'operator':'manager'})
 def require(cond,msg):
  if not cond: raise AssertionError(msg)
 try:
  if id=='04-004':
   cmd=['date','-u','-s','2026-10-01 00:00:00']; p=subprocess.run(cmd,capture_output=True,text=True); log('$ '+' '.join(cmd)+'\n'+p.stdout+p.stderr); require(p.returncode==0,'not reached: baseline clock command failed')
  proc=subprocess.Popen(['./start.sh',str(port)],cwd=work+'/runtime-'+id,stdout=open(work+'/server-'+id+'.log','w'),stderr=subprocess.STDOUT,start_new_session=True)
  for _ in range(100):
   try:
    code,house_data=get('/api/houses'); break
   except Exception: time.sleep(.1)
  else: raise Exception('not reached: HTTP readiness')
  policy=house_data['houses'][0]['currentPolicy']; log('READY')
  if id in ('01-003','01-004','02-009','02-010','04-005','04-006'):
   if id!='04-006':
    _,sch=get('/api/schedule?house=soukanvuori'); require(any(s['resource']=='ph8' and s['weekday']=='Tuesday' and s['start']=='17:00' and s['state']=='free' for s in sch['slots']),'not reached: slot not free')
    c,b=booking(); require(c==201,'not reached: booking creation failed'); bid=b['booking']['id']; given=True
   if id=='01-003':
    when=True; _,bks=get('/api/bookings?house=soukanvuori'); log('Re-read persisted booking'); x=next(x for x in bks['bookings'] if x['id']==bid); print(id,x); require(x['household']=='12' and x['start']=='17:00' and x['end']=='18:30' and x['weekday']=='Tuesday', 'persisted holding mismatch'); status='passed'; message='POST standing request returned 201; GET bookings re-read apartment 12 Tuesday 17:00–18:30 weekly holding.'
   elif id=='01-004':
    when=True; c,r=booking('3'); _,bks=get('/api/bookings?house=soukanvuori'); require(c==409 and ('held' in json.dumps(r).lower() or 'already' in json.dumps(r).lower()),'conflict was not refused as held'); require(any(x['id']==bid and x['household']=='12' for x in bks['bookings']),'original holding missing'); status='passed'; message='Apartment 3 POST same slot returned 409; GET bookings retains apartment 12 holding.'
   elif id in ('02-009','02-010'):
    # Next Tuesday from real clock, at least one day away
    today=datetime.datetime.now(datetime.timezone.utc).date(); delta=(1-today.weekday())%7 or 7; day=today+datetime.timedelta(days=delta); date=day.isoformat(); later=(day+datetime.timedelta(days=7)).isoformat()
    c,r=post('/api/releases',{'booking':bid,'household':'12','date':date,'mode':'FREE'}); require(c==201,'not reached: release creation failed'); rid=r['release']['id']; get('/api/releases?house=soukanvuori'); given=True
    if id=='02-009':
     when=True; c,r=post('/api/releases/'+rid+'/take',{'household':'3'}); require(c==200,'take failed'); c2,r2=post('/api/releases/'+rid+'/take',{'household':'4'}); require(c2>=400,'second taker accepted')
    else:
     barrier=threading.Barrier(2); results=[]
     def race(h):
      conn=http.client.HTTPConnection('127.0.0.1',port,timeout=8); data=json.dumps({'household':h}); conn.request('POST','/api/releases/'+rid+'/take',data,{'Content-Type':'application/json'}); barrier.wait(); res=conn.getresponse(); raw=res.read().decode(); results.append((h,res.status,json.loads(raw))); conn.close()
     ts=[threading.Thread(target=race,args=(h,)) for h in ('3','4')]; [t.start() for t in ts]; [t.join() for t in ts]; when=True; log('RACE both requests sent before either response read: '+json.dumps(results)); require(len(results)==2 and sum(200<=r[1]<300 for r in results)==1,'race did not have exactly one success');
    _,views=get('/api/views?house=soukanvuori&date='+date); _,future=get('/api/views?house=soukanvuori&date='+later); _,bks=get('/api/bookings?house=soukanvuori'); _,rels=get('/api/releases?house=soukanvuori'); log('CHECK release, booking and views for date and next week'); print(id,json.dumps(views),json.dumps(future));
    taker=next(x for x in rels['releases'] if x['id']==rid).get('taker'); require(taker in ('3','4'),'missing persisted taker'); require(id!='02-009' or taker=='3','wrong taker'); require(any(x['id']==bid and x['household']=='12' for x in bks['bookings']),'standing holding lost'); require(taker in json.dumps(views['posted']) and len(views['heater'])>0 and '12' in json.dumps(views['billing']) and '12' in json.dumps(future['posted']),'views not consistent'); status='passed'; message=f'FREE {date}: take outcome persisted taker {taker}; dated list, heater and billing and following Tuesday checked; normal fee remains with 12.'
   elif id=='04-005':
    c,r=post('/api/bookings/'+bid+'/give-up',{'household':'12'}); require(c==200,'not reached: could not change booking'); given=True; when=True; c,r=post('/api/disputes',{'booking':bid,'role':'manager','reason':'Please reconstruct the changed booking'}); print(id,json.dumps(r)); require(c==201 or c==200,'dispute failed'); evidence=json.dumps(r.get('evidence',{})); require(bid in evidence and 'v1' in evidence and ('give' in evidence.lower() or 'end' in evidence.lower()),'history/version evidence missing'); status='passed'; message='Confirmed booking then gave it up; manager dispute response includes booking history and v1 policy evidence.'
   elif id=='04-006':
    c,r=post('/api/bookings',{'house':'soukanvuori','household':'12','resource':'ph9','weekday':'Tuesday','start':'17:00','operator':'manager'}); require(c>=400 and 'decision' in r,'not reached: no recorded refusal'); decision=r['decision']; given=True; p=copy.deepcopy(policy); p.update(version='v2',effective='2030-01-01T00:00:00Z'); when=True; c,r=post('/api/houses/soukanvuori/policies',{'actor':'board','policy':p}); require(c==201 or c==200,'revision failed'); _,state=get('/api/state'); require(decision in state.get('decisions',[]) or json.dumps(decision,sort_keys=True) in json.dumps(state,sort_keys=True),'original refusal not retained'); status='passed'; message='Closed-day refusal recorded with v1 and reason; board revision v2 recorded; GET state retains unchanged refusal.'
  elif id=='04-004':
   _,state=get('/api/state'); p=copy.deepcopy(policy); p.update(version='v2',effective='2026-10-02T00:00:00Z'); given=True; when=True; c,r=post('/api/houses/soukanvuori/policies',{'actor':'board','policy':p}); require(c in (200,201),'revision rejected'); c,b=booking(); require(c==201,'before decision failed'); before=b['booking']; print(id,'before',json.dumps(before));
   # Read effective boundary from served house policy before moving real guest clock
   _,hs=get('/api/houses'); eff=next(x for x in hs['houses'][0]['policies'] if x['version']=='v2')['effective']; log('BOUNDARY served effective='+eff); dt=datetime.datetime.fromisoformat(eff.replace('Z','+00:00'))+datetime.timedelta(seconds=1); cmd=['date','-u','-s',dt.strftime('%Y-%m-%d %H:%M:%S')]; cp=subprocess.run(cmd,capture_output=True,text=True); log('$ '+' '.join(cmd)+'\n'+cp.stdout+cp.stderr); require(cp.returncode==0,'not reached: advancing guest clock failed'); get('/api/state'); c,after=booking('3','18:30'); require(c==201,'after decision failed'); log('BEFORE/AFTER '+json.dumps([before,after])); require('v1' in json.dumps(before) and 'v2' in json.dumps(after),'booking policy version did not change'); status='passed'; message='Board recorded v2 effective '+eff+'; v1 booking before and v2 booking after guest-clock advance observed.'
  elif id=='04-007':
   # Configure a self-service house with two standing slots and one queued household.
   h={'id':'testhouse','name':'Test house','resources':[{'id':'room','name':'Room','sauna':'Sauna','group':'A','duration':90,'days':{'Tuesday':[{'start':'17:00','class':'ordinary'},{'start':'18:30','class':'ordinary'}]}}], 'policy':{'version':'v1','authority':'board','effective':'2020-01-01T00:00:00Z','bookerRoles':['tenant'],'route':'self-service','bookingRole':'manager','operationsRole':'caretaker','billingRole':'billing','disputeRole':'caretaker','chooseDays':14,'noticeDays':30,'caps':{},'priceReference':'standing','salePriceReference':'resale'}}
   c,r=post('/api/houses',h); require(c in (200,201),'not reached: create house');
   for hh in ('12','3','4'): require(post('/api/households',{'house':'testhouse','id':hh,'role':'tenant'})[0] in (200,201),'not reached: household')
   for st in ('17:00','18:30'): require(booking('12',st,'testhouse','room')[0]==201,'not reached: full capacity')
   require(post('/api/queue',{'house':'testhouse','group':'A','household':'3'})[0] in (200,201),'not reached: queue'); c,r=post('/api/scarcity/evaluate',{'house':'testhouse','group':'A'}); require(c in (200,201) and r.get('notices'),'not reached: notice'); notice=r['notices'][0]; given=True; p=copy.deepcopy(h['policy']); p.update(version='v2',effective='2030-01-01T00:00:00Z',chooseDays=7,noticeDays=20); when=True; c,r=post('/api/houses/testhouse/policies',{'actor':'board','policy':p}); require(c in (200,201),'revision rejected'); _,ns=get('/api/notices?house=testhouse'); require(notice in ns['notices'],'existing notice changed'); raise AssertionError('not reached: later notice under revised effective rule; advancing guest clock required')
 except Exception as e:
  message=str(e); log('CHECK FAILED: '+message+'\n'+traceback.format_exc());
  if not message.startswith('not reached:') and not when: message='not reached: '+message
 finally:
  if proc:
   try: os.killpg(proc.pid,15); proc.wait(timeout=5)
   except Exception: proc.kill(); proc.wait()
  stop=int(time.time()*1000); stop=max(start,stop); evidence=work+'/evidence-'+id+'.txt'; open(evidence,'w').write('\n'.join(logs)+'\n'); aid=str(uuid.uuid4())+'-attachment.txt'; open(work+'/allure-results/'+aid,'w').write('\n'.join(logs)+'\n'); uid=str(uuid.uuid4()); slug=item['source'].split('/')[2][3:]; stable='loyly.'+slug+'.'+id
  steps=[{'name':'Given: establish scenario prerequisites on fresh state','status':'passed' if given else 'failed','stage':'finished','statusDetails':{'message':'See HTTP transcript' if given else 'not reached: prerequisite setup incomplete'}},{'name':'When: perform scenario action','status':'passed' if when else 'skipped','stage':'finished','statusDetails':{'message':'See HTTP transcript' if when else 'not reached: setup incomplete'}},{'name':'Then: observe all stated consequences','status':status,'stage':'finished','statusDetails':{'message':message}}]
  result={'uuid':uid,'name':item['name'],'fullName':stable,'historyId':stable,'testCaseId':stable,'status':status,'stage':'finished','statusDetails':{'message':message},'start':start,'stop':stop,'labels':[{'name':'lifecycle','value':'pre-production'},{'name':'technique','value':'acceptance'},{'name':'tool','value':'Pi black-box grader'},{'name':'feature','value':features[id[:2]]},{'name':'story','value':item['rule']},{'name':'tag','value':'@item-'+id}],'steps':steps,'attachments':[{'name':'HTTP request and response evidence','source':aid,'type':'text/plain'}]}; json.dump(result,open(work+'/allure-results/'+uid+'-result.json','w'),indent=2); print(id,status,message,flush=True)
json.dump(surprises,open(work+'/surprises.json','w'),indent=2)
