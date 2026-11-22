import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createPage } from './browser-test-support.mjs';
import { makeCycle } from './stock-test-support.mjs';
import { parseNasdaqCalendar } from './update-nasdaq-calendar.mjs';
const calendar=parseNasdaqCalendar(await readFile(new URL('./fixtures/nasdaq-2026.html',import.meta.url),'utf8'),2026,'2026-11-21');
async function scenario(filename,calendars={2026:calendar}) {
  const history={activeCycle:makeCycle(),history:[]};
  const page=await createPage(filename,history,{schemaVersion:1,sessions:[]},{},{calendars,renderCalendar:true,now:'2027-01-01T02:00:00Z'});
  await page.init();
  return page;
}
async function select(page,date) {
  page.element('target-date-input').value=date;
  return page.element('target-date-input').handlers.change({target:{value:date}});
}
for(const filename of ['admin_cycle_manager.html','Nav_record_stock.html']) {
  test(`${filename}: preview already uses Nasdaq before Apply and leaves the open cycle untouched`,async()=>{
    const page=await scenario(filename);
    const before=page.snapshot();
    await select(page,'2026-12-10');
    assert.match(page.element('calendar-source-status').textContent,/Nasdaq 2026/);
    assert.match(page.element('calendar-preview-sessions').textContent,/9\. 2026-11-23/);
    assert.match(page.element('calendar-preview-sessions').textContent,/11\. 2026-11-25/);
    assert.match(page.element('calendar-preview-sessions').textContent,/13:00 ET/);
    assert.deepEqual(page.snapshot(),before);
    assert.equal(page.element('btn-apply-cycle').disabled,false);
    assert.equal(page.element('skippedHolidaysList').children[0].textContent,'2026-11-26: Thanksgiving Day - U.S.');
  });
  test(`${filename}: preview labels each source during a cross-year calculation`,async()=>{
    const page=await scenario(filename);
    page.run("currentLang='vi'");
    await select(page,'2027-01-15');
    assert.equal(page.element('calendar-source-status').textContent,'Nasdaq 2026 · Lịch dự kiến 2027');
    assert.equal(page.run('formatDateKey(task1Result.startDate)'),'2026-12-16');
  });
  test(`${filename}: slow old result cannot replace a newer cut-off or saved cycle`,async()=>{
    const page=await scenario(filename);
    let release;
    const gate=new Promise(resolve=>{release=resolve;});
    page.data.beforeResponse=url=>url.includes('nasdaq-2026')?gate:undefined;
    const old=select(page,'2026-12-10');
    assert.equal(page.element('btn-apply-cycle').disabled,true);
    await select(page,'2027-03-15');
    const date=page.run('formatDateKey(task1Result.targetDate)');
    release(); await old;
    assert.equal(page.run('formatDateKey(task1Result.targetDate)'),date);
    assert.equal(date,'2027-03-15');
    page.data.beforeResponse=undefined;
    let releaseAgain;
    const gateAgain=new Promise(resolve=>{releaseAgain=resolve;});
    page.data.beforeResponse=url=>url.includes('nasdaq-2026')?gateAgain:undefined;
    const pending=select(page,'2026-12-10');
    page.run(filename.startsWith('admin')?'loadActiveCycleFromPackage(publishedAdminCycle)':'forceApplyMasterCycle(masterJsonActiveCycle)');
    const saved=page.snapshot();
    releaseAgain(); await pending;
    assert.deepEqual(page.snapshot(),saved);
    assert.equal(page.run('task1Result.calendarSources'),undefined);
    assert.equal(page.element('btn-apply-cycle').disabled,true);
  });
  test(`${filename}: Apply cannot use the last preview after input changes or while loading`,async()=>{
    const page=await scenario(filename);
    await select(page,'2026-12-10');
    const before=page.snapshot();
    page.element('target-date-input').value='2027-03-15';
    await page.element('btn-apply-cycle').handlers.click();
    assert.deepEqual(page.snapshot(),before);
    page.element('target-date-input').handlers.input();
    assert.equal(page.element('btn-apply-cycle').disabled,true);
  });
  test(`${filename}: a deliberate recalculation loads newly available JSON; offline fallback is visible`,async()=>{
    const page=await scenario(filename,{});
    page.run("currentLang='vi'");
    await select(page,'2026-12-10');
    assert.equal(page.element('calendar-source-status').textContent,'Lịch dự kiến 2026');
    page.data.calendars[2026]=calendar;
    await page.element('btn-recalculate-calendar').handlers.click();
    assert.equal(page.element('calendar-source-status').textContent,'Nasdaq 2026');
    page.data.offline=true;
    await page.element('btn-recalculate-calendar').handlers.click();
    assert.equal(page.element('calendar-source-status').textContent,'Lịch dự kiến 2026');
  });
  test(`${filename}: holiday names from Nasdaq are rendered as text`,async()=>{
    const hostile=structuredClone(calendar);
    hostile.holidayNames['2026-11-26']='<img src=x onerror=alert(1)>';
    const page=await scenario(filename,{2026:hostile});
    await select(page,'2026-12-10');
    const item=page.element('skippedHolidaysList').children[0];
    assert.match(item.textContent,/<img/);
    assert.equal(item.innerHTML,'');
  });
  test(`${filename}: Today converts the timestamp to a New York calendar date`,async()=>{
    const page=await scenario(filename);
    page.element('btn-today').handlers.click();
    assert.equal(page.element('target-date-input').value,'2026-12-31');
  });
}
test('User saving the open cycle while previewing a different year keeps applied metadata and sessions',async()=>{
  const page=await scenario('Nav_record_stock.html');
  const before=page.snapshot();
  await select(page,'2027-03-15');
  await page.element('btn-save-history').handlers.click();
  const saved=JSON.parse(page.run('JSON.stringify(userLocalHistory[0])'));
  assert.equal(saved.startDate,before.meta.startDate);
  assert.equal(saved.endDate,before.meta.endDate);
  assert.equal(saved.year,before.meta.year);
  assert.equal(saved.sessions[0].dateIso,before.sessions[0].date.slice(0,10));
});
test('Admin dispatch reuses saved configuration, blocks duplicate sends, and links the accepted run',async()=>{
  const page=await scenario('admin_cycle_manager.html');
  assert.equal(page.element('nasdaq-calendar-year').value,'2026');
  page.run("gitConfig={repo:'Namvo0101/App',branch:'calendar-test',token:'test-only-token'}");
  page.element('nasdaq-calendar-year').value='2027';
  page.data.dispatchResponse={ok:true,status:200,json:async()=>({workflow_run_id:123})};
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  page.data.beforeResponse=url=>url.startsWith('https:')?gate:undefined;
  const send=page.element('btn-update-nasdaq-calendar').handlers.click;
  const pending=send(); await send();
  assert.equal(page.element('btn-update-nasdaq-calendar').disabled,true);
  assert.equal(page.data.requestOptions.filter(options=>options?.method==='POST').length,1);
  release(); await pending;
  const options=page.data.requestOptions.find(options=>options?.method==='POST');
  const body=JSON.parse(options.body);
  assert.equal(body.ref,'calendar-test');
  assert.equal(body.inputs.year,'2027');
  assert.match(body.inputs.request_id,/^nav-/);
  assert.match(page.element('nasdaq-calendar-update-status').textContent,/Đã gửi yêu cầu/);
  assert.equal(page.element('nasdaq-calendar-run-link').href,'https://github.com/Namvo0101/App/actions/runs/123');
});
for(const status of [204,403,404]) test(`Admin dispatch handles HTTP ${status} without displaying a token`,async()=>{
  const page=await scenario('admin_cycle_manager.html');
  page.run("gitConfig={repo:'Namvo0101/App',branch:'main',token:'test-only-token'}");
  page.data.dispatchResponse={ok:status===204,status,json:async()=>({message:'test-only-token'})};
  await page.element('btn-update-nasdaq-calendar').handlers.click();
  const message=page.element('nasdaq-calendar-update-status').textContent;
  assert(!message.includes('test-only-token'));
  if(status===204) assert.equal(page.element('nasdaq-calendar-run-link').href,'https://github.com/Namvo0101/App/actions/workflows/update-nasdaq-calendar.yml');
  else assert.match(message,status===403?/Actions/:/workflow/);
});

async function trackingPage() {
  const page=await scenario('admin_cycle_manager.html');
  page.run("gitConfig={repo:'Namvo0101/App',branch:'main',token:'test-only-token'}");
  page.element('nasdaq-calendar-year').value='2026';
  page.data.dispatchResponse={ok:true,status:200,json:async()=>({workflow_run_id:123})};
  await page.element('btn-update-nasdaq-calendar').handlers.click();
  return page;
}
const trackedRun=(status,conclusion=null)=>({id:123,head_branch:'main',event:'workflow_dispatch',path:'.github/workflows/update-nasdaq-calendar.yml',status,conclusion});
const savedJob={name:'update',status:'completed',conclusion:'success',steps:[{name:'Commit only the requested calendar',conclusion:'success'}]};
test('Admin shows queue, deployment and success on the page without applying or changing the open cycle',async()=>{
  const page=await trackingPage();const before=page.snapshot();
  assert.equal(page.element('nasdaq-calendar-update-status')['data-status'],'queued');
  assert.equal(page.element('btn-update-nasdaq-calendar').disabled,true);
  page.data.actionRun=trackedRun('in_progress');
  page.data.actionJobs=[savedJob,{name:'deploy',status:'in_progress'}];
  await page.element('btn-check-nasdaq-calendar').handlers.click();
  assert.equal(page.element('nasdaq-calendar-update-status')['data-status'],'deploying');
  assert.match(page.element('nasdaq-calendar-update-status').textContent,/Đang phát hành/);
  page.data.actionRun=trackedRun('completed','success');
  page.data.actionJobs=[savedJob,{name:'deploy',conclusion:'success'}];
  await page.element('btn-check-nasdaq-calendar').handlers.click();
  assert.equal(page.element('nasdaq-calendar-update-status')['data-status'],'success');
  assert.equal(page.element('btn-update-nasdaq-calendar').disabled,false);
  assert.match(page.element('nasdaq-calendar-update-status').textContent,/Bấm Tính lại/);
  assert.deepEqual(page.snapshot(),before);
  assert.equal(page.data.requestOptions.filter(o=>o?.method==='POST').length,1);
});
test('Admin differentiates a failed publication from a failed calendar update',async()=>{
  const page=await trackingPage();
  page.data.actionRun=trackedRun('completed','failure');
  page.data.actionJobs=[savedJob,{name:'deploy',conclusion:'failure'}];
  await page.element('btn-check-nasdaq-calendar').handlers.click();
  assert.equal(page.element('nasdaq-calendar-update-status')['data-status'],'failed');
  assert.match(page.element('nasdaq-calendar-update-status').textContent,/đã lưu trên GitHub.*phát hành thất bại/);
});
test('Admin resumes the saved run after reload using GET only',async()=>{
  const page=await trackingPage();
  const saved=Object.fromEntries(page.storage);
  saved.NAV_ADMIN_GIT_CONFIG=JSON.stringify({repo:'Namvo0101/App',branch:'main',token:'test-only-token'});
  const reloaded=await createPage('admin_cycle_manager.html',page.data.history,page.data.feed,saved,{renderCalendar:true});
  reloaded.data.actionRun=trackedRun('completed','success');
  reloaded.data.actionJobs=[savedJob,{name:'deploy',conclusion:'success'}];
  await reloaded.init();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reloaded.element('nasdaq-calendar-update-status')['data-status'],'success');
  assert(!reloaded.data.requestOptions.some(o=>o?.method==='POST'));
  assert.equal(reloaded.element('nasdaq-calendar-run-link').href,'https://github.com/Namvo0101/App/actions/runs/123');
});
test('Admin reading permission errors show an unknown result and never send another dispatch',async()=>{
  const page=await trackingPage();
  page.data.actionsResponse={ok:false,status:403};
  await page.element('btn-check-nasdaq-calendar').handlers.click();
  assert.equal(page.element('nasdaq-calendar-update-status')['data-status'],'unknown');
  assert.match(page.element('nasdaq-calendar-update-status').textContent,/Chưa xác định/);
  assert.equal(page.data.requestOptions.filter(o=>o?.method==='POST').length,1);
});
