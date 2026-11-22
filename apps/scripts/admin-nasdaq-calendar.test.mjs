import assert from 'node:assert/strict';
import test from 'node:test';
import '../admin-nasdaq-calendar.js';
const {dispatch}=globalThis.NasdaqCalendarAdmin;
const {inspect,createTracker,STORAGE_KEY}=globalThis.NasdaqCalendarAdmin;
const config={repo:'Namvo0101/App',branch:'main',token:'test-only-secret'};
test('Invalid configuration/year is rejected before any network request',async()=>{
  let calls=0;
  const fetcher=async()=>{calls++;throw new Error('unexpected');};
  for(const options of [{config:{...config,token:''},year:2026},{config:{...config,repo:'https://example.com'},year:2026},{config,year:'2026; echo secret'},{config,year:2026.5}]) {
    await assert.rejects(dispatch({...options,fetch:fetcher}),/YEAR|CONFIG/);
  }
  assert.equal(calls,0);
});
test('Network exception text and untrusted run URL cannot leak into the result',async()=>{
  await assert.rejects(dispatch({config,year:2026,fetch:async()=>{throw new Error(config.token);}}),error=>error.message==='NETWORK'&&!error.message.includes(config.token));
  const result=await dispatch({config,year:2026,fetch:async()=>({ok:true,status:200,json:async()=>({html_url:`https://malicious.example/${config.token}`})})});
  assert.equal(result.url,'https://github.com/Namvo0101/App/actions/workflows/update-nasdaq-calendar.yml');
});
test('Accepted responses with invalid JSON still report dispatch acceptance',async()=>{
  const result=await dispatch({config,year:2026,fetch:async()=>({ok:true,status:200,json:async()=>{throw new Error('no body');}})});
  assert.match(result.url,/workflows\/update-nasdaq-calendar.yml$/);
});

const record={repo:config.repo,branch:'main',year:'2026',requestId:'nav-test-request-123',runId:'42'};
const run=(status='in_progress',conclusion=null)=>({id:42,head_branch:'main',event:'workflow_dispatch',path:'.github/workflows/update-nasdaq-calendar.yml',status,conclusion});
const commit={name:'Commit only the requested calendar',conclusion:'success'};
const updated={name:'update',status:'completed',conclusion:'success',steps:[commit]};
function api(runData=run(),jobs=[]) {
  return async url=>({ok:true,status:200,json:async()=>url.includes('/jobs?')?{jobs}:runData});
}
for(const scenario of [
  {phase:'queued',run:run('queued'),jobs:[]},
  {phase:'updating',run:run(),jobs:[{name:'update',status:'in_progress'}]},
  {phase:'deploying',run:run(),jobs:[updated,{name:'deploy',status:'in_progress'}]},
  {phase:'success',run:run('completed','success'),jobs:[updated,{name:'deploy',conclusion:'success'}],done:true},
  {phase:'failed',run:run('completed','failure'),jobs:[{name:'update',conclusion:'failure'}],done:true},
  {phase:'failed',run:run('completed','failure'),jobs:[updated,{name:'deploy',conclusion:'failure'}],done:true,saved:true},
  {phase:'cancelled',run:run('completed','cancelled'),jobs:[],done:true},
  {phase:'saved_only',run:run('completed','success'),jobs:[updated,{name:'deploy',conclusion:'skipped'}],done:true},
  {phase:'verifying',run:run('completed','success'),jobs:[updated]}
]) test(`Tracking distinguishes ${scenario.phase}${scenario.saved?' after committing':''}`,async()=>{
  const state=await inspect({config,request:record,fetch:api(scenario.run,scenario.jobs)});
  assert.equal(state.phase,scenario.phase);
  assert.equal(state.done,!!scenario.done);
  if(scenario.saved)assert.equal(state.saved,true);
});
test('Legacy dispatch is correlated by request ID and ignores a newer unrelated workflow',async()=>{
  const request={...record,runId:null};
  const calls=[];
  const fetcher=async url=>{
    calls.push(url);
    const data=url.includes('/workflows/')?{workflow_runs:[{...run(),id:99,display_title:'Nasdaq 2026 [nav-another-request]'},{...run(),display_title:`Nasdaq 2026 [${record.requestId}]`}]}:url.includes('/jobs?')?{jobs:[]}:run();
    return {ok:true,status:200,json:async()=>data};
  };
  const result=await inspect({config,request,fetch:fetcher});
  assert.equal(result.request.runId,'42');
  assert(calls.some(url=>url.endsWith('/runs/42')));
  assert(!calls.some(url=>url.includes('/runs/99')));
});
test('A legacy request with no matching title stays unconfirmed',async()=>{
  const result=await inspect({config,request:{...record,runId:null},fetch:async()=>({ok:true,status:200,json:async()=>({workflow_runs:[{...run(),display_title:'An unrelated successful run'}]})})});
  assert.equal(result.phase,'locating');
  assert.equal(result.done,false);
});
test('Mismatched workflow or branch is never shown as success',async()=>{
  for(const bad of [{...run(),head_branch:'other'},{...run(),path:'.github/workflows/update-stock-prices.yml'},{...run(),event:'push'}]) {
    await assert.rejects(inspect({config,request:record,fetch:api(bad)}),/RESPONSE/);
  }
});
function trackerScenario() {
  const states=[],requests=[],storage=new Map(),timers=new Map();
  let index=0,time=0,getError=null,runData=run('queued'),jobs=[];
  const tracker=createTracker({getConfig:()=>config,onChange:state=>states.push(structuredClone(state)),
    storage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    now:()=>time,maxTrackingMs:100,
    setTimer:callback=>{const id=++index;timers.set(id,callback);return id;},clearTimer:id=>timers.delete(id),
    fetch:async(url,options)=>{
      requests.push({url,method:options.method});
      if(options.method==='POST')return {ok:true,status:200,json:async()=>({workflow_run_id:42})};
      if(getError)throw new Error(getError);
      return api(runData,jobs)(url);
    }});
  return {tracker,states,requests,storage,timers,setError:error=>{getError=error;},setTime:value=>{time=value;},setResult:(r,j)=>{runData=r;jobs=j;},
    tick:async()=>{const [id,callback]=timers.entries().next().value;timers.delete(id);callback();await new Promise(resolve=>setImmediate(resolve));}};
}
test('Tracker polls to deployment success, persists no credentials, and never repeats POST',async()=>{
  const s=trackerScenario();
  await s.tracker.start(2026);
  assert.equal(s.states.at(-1).phase,'queued');
  assert(!s.storage.get(STORAGE_KEY).includes(config.token));
  await s.tracker.start(2026);
  assert.equal(s.requests.filter(r=>r.method==='POST').length,1);
  s.setResult(run(),[updated,{name:'deploy',status:'in_progress'}]);
  await s.tick();
  assert.equal(s.states.at(-1).phase,'deploying');
  s.setResult(run('completed','success'),[updated,{name:'deploy',conclusion:'success'}]);
  await s.tick();
  assert.equal(s.states.at(-1).phase,'success');
  assert.equal(s.timers.size,0);
  assert.equal(s.requests.filter(r=>r.method==='POST').length,1);
});
test('Network monitoring errors retry GET only and end as unknown, not workflow failure',async()=>{
  const s=trackerScenario();s.setError(config.token);
  await s.tracker.start(2026);await s.tick();await s.tick();
  assert.equal(s.states.at(-1).phase,'unknown');
  assert(!JSON.stringify(s.states).includes(config.token));
  assert.equal(s.requests.filter(r=>r.method==='POST').length,1);
  assert.equal(s.timers.size,0);
  s.setError(null);s.setResult(run('completed','success'),[updated,{name:'deploy',conclusion:'success'}]);
  await s.tracker.resume();
  assert.equal(s.states.at(-1).phase,'success');
  assert.equal(s.requests.filter(r=>r.method==='POST').length,1);
});
test('Automatic tracking timeout preserves the request and does not claim failure',async()=>{
  const s=trackerScenario();await s.tracker.start(2026);s.setTime(101);await s.tick();
  assert.equal(s.states.at(-1).phase,'timeout');assert(s.storage.has(STORAGE_KEY));assert.equal(s.timers.size,0);
});
test('Reload restores only request metadata and queries the exact run without dispatch',async()=>{
  const states=[],requests=[];
  const saved=JSON.stringify({...record,token:'must-not-be-retained'});
  const stored=new Map([[STORAGE_KEY,saved]]);
  const tracker=createTracker({getConfig:()=>config,onChange:state=>states.push(state),
    storage:{getItem:key=>stored.get(key),setItem:(key,value)=>stored.set(key,value)},
    fetch:async(url,options)=>{requests.push(options.method);return api(run('completed','success'),[updated,{name:'deploy',conclusion:'success'}])(url);}});
  await tracker.restore();
  assert.equal(states.at(-1).phase,'success');
  assert(requests.every(method=>method==='GET'));
  assert(!stored.get(STORAGE_KEY).includes('token'));
});
test('Stopping tracking prevents a late response from changing the displayed result',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});const states=[];
  const tracker=createTracker({getConfig:()=>config,onChange:state=>states.push(state),storage:{getItem:()=>JSON.stringify(record)},
    fetch:async url=>{await gate;return api(run('completed','success'),[updated,{name:'deploy',conclusion:'success'}])(url);}});
  const pending=tracker.restore();tracker.stop();const count=states.length;release();await pending;
  assert.equal(states.length,count);
});
