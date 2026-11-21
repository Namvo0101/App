import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import '../market-calendar.js';
import { parseNasdaqCalendar } from './update-nasdaq-calendar.mjs';
const C=globalThis.MarketCalendar;
const html=await readFile(new URL('./fixtures/nasdaq-2026.html',import.meta.url),'utf8');
const official=parseNasdaqCalendar(html,2026,'2026-11-21');
const fallback=year=>Promise.resolve({year,source:'rule',holidays:C.fallbackHolidays(year),earlyCloses:{}});
const iso=result=>result.tradingSessions.map(C.dateKey);
const expected=['2026-11-11','2026-11-12','2026-11-13','2026-11-16','2026-11-17','2026-11-18','2026-11-19','2026-11-20','2026-11-23','2026-11-24','2026-11-25','2026-11-27','2026-11-30','2026-12-01','2026-12-02','2026-12-03','2026-12-04','2026-12-07','2026-12-08','2026-12-09'];
for(const source of ['rule','nasdaq']) test(`Thanksgiving 2026: all 20 sessions are correct using ${source}`,async()=>{
  const result=await C.calculateCycle('2026-12-10',{loadYear:source==='rule'?fallback:async year=>C.validateCalendar(official,year)});
  assert.deepEqual(iso(result),expected);
  assert.deepEqual(result.skippedHolidays.map(h=>C.dateKey(h.date)),['2026-11-26']);
  assert.equal(result.weekendDaysCount,8);
  assert.match(result.skippedHolidays[0].name.en,/Thanksgiving/);
  if(source==='nasdaq') assert.equal(result.earlyCloses['2026-11-27'],'13:00');
});
for(const years of [[],[2026],[2027],[2026,2027]]) test(`Cross-year calculation selects each year's source: JSON ${years.join(',')||'none'}`,async()=>{
  const requested=[];
  const loader=C.createYearLoader({fetch:async url=>{
    requested.push(url);
    const year=Number(url.match(/(\d{4})\.json$/)[1]);
    const json=year===2026?official:{year,closedDates:Object.keys(C.fallbackHolidays(year))};
    return {ok:years.includes(year),json:async()=>json};
  }});
  const result=await C.calculateCycle('2027-01-15',{loadYear:loader});
  assert.equal(iso(result)[0],'2026-12-16');
  assert.equal(iso(result).at(-1),'2027-01-14');
  assert.equal(iso(result).filter(d=>d.startsWith('2026')).length,11);
  assert.equal(iso(result).filter(d=>d.startsWith('2027')).length,9);
  assert(iso(result).includes('2026-12-24'));
  assert.deepEqual(result.skippedHolidays.map(h=>C.dateKey(h.date)),['2027-01-01','2026-12-25']);
  assert.deepEqual(result.calendarSources.map(({year,source})=>[year,source]),[2026,2027].map(year=>[year,years.includes(year)?'nasdaq':'rule']));
  assert.equal(requested.length,2);
});
test('JSON is the sole holiday source even when fallback rules disagree',async()=>{
  const json={year:2026,closedDates:['2026-11-23'],holidayNames:{'2026-11-23':'Verified exceptional closure'}};
  const result=await C.calculateCycle('2026-12-10',{loadYear:async y=>C.validateCalendar(json,y)});
  assert(!iso(result).includes('2026-11-23'));
  assert(iso(result).includes('2026-11-26'));
  assert.equal(result.skippedHolidays[0].name.en,'Verified exceptional closure');
});
test('Counting includes holidays and weekends between the cut-off and last session',async()=>{
  const result=await C.calculateCycle('2026-12-28',{loadYear:fallback});
  assert.equal(C.dateKey(result.endDate),'2026-12-24');
  assert(result.skippedHolidays.some(h=>C.dateKey(h.date)==='2026-12-25'));
  assert.equal(result.holidaysCount,1);
  assert.equal(result.weekendDaysCount,10);
});
test('Juneteenth starts in 2022 and Saturday New Year does not close December 31',()=>{
  assert.equal(C.fallbackHolidays(2021)['2021-06-18'],undefined);
  assert.match(C.fallbackHolidays(2022)['2022-06-20'].en,/Juneteenth/);
  assert.equal(C.fallbackHolidays(2027)['2027-12-31'],undefined);
  assert.equal(C.fallbackHolidays(2028)['2027-12-31'],undefined);
  assert(C.fallbackHolidays(2023)['2023-01-02']);
  assert(C.fallbackHolidays(2026)['2026-04-03']);
});
test('Timestamp dates use New York at midnight boundaries and during daylight saving time',()=>{
  assert.equal(C.newYorkDate(new Date('2027-01-01T02:00:00Z')),'2026-12-31');
  assert.equal(C.newYorkDate(new Date('2026-07-01T03:30:00Z')),'2026-06-30');
  assert.equal(C.dateKey(C.parseDate('2026-11-26')),'2026-11-26');
  assert.throws(()=>C.parseDate('2026-02-30'));
});
test('Legacy closedDates-only JSON remains valid and gets a generic name',()=>{
  const result=C.validateCalendar({year:2025,closedDates:['2025-01-09']},2025);
  assert.match(result.holidays['2025-01-09'].en,/Nasdaq/);
});
for(const bad of [
  {...official,year:2027}, {...official,timeZone:'UTC'}, {...official,closedDates:['2026-02-30']},
  {...official,closedDates:['2026-11-26','2026-11-26']}, {...official,closedDates:[]},
  {...official,holidayNames:{'2026-11-26':''}}, {...official,earlyCloses:{'2026-11-26':'13:00'}},
  {...official,earlyCloses:{'2026-11-27':'25:00'}}
]) test(`Invalid runtime JSON falls back: ${JSON.stringify(bad).slice(-65)}`,async()=>{
  const loader=C.createYearLoader({fetch:async()=>({ok:true,json:async()=>bad})});
  assert.equal((await loader(2026)).source,'rule');
});
test('Network errors, invalid JSON and timeouts fall back without retaining failure between calculations',async()=>{
  for(const fetcher of [async()=>{throw new Error('offline');},async()=>({ok:true,json:async()=>{throw new Error('invalid JSON');}}),()=>new Promise(()=>{})]) {
    const load=C.createYearLoader({fetch:fetcher,timeoutMs:10});
    assert.equal((await load(2026)).source,'rule');
  }
  let calls=0;
  const fetcher=async()=>({ok:++calls>1,json:async()=>official});
  assert.equal((await C.createYearLoader({fetch:fetcher})(2026)).source,'rule');
  assert.equal((await C.createYearLoader({fetch:fetcher})(2026)).source,'nasdaq');
});
