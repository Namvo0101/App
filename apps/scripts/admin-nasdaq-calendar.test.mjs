import assert from 'node:assert/strict';
import test from 'node:test';
import '../admin-nasdaq-calendar.js';
const {dispatch}=globalThis.NasdaqCalendarAdmin;
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
