import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseNasdaqCalendar, mergeExceptions, updateCalendar } from './update-nasdaq-calendar.mjs';
const html=await readFile(new URL('./fixtures/nasdaq-2026.html',import.meta.url),'utf8');
const parse=(source=html)=>parseNasdaqCalendar(source,2026,'2026-11-21');
test('Official 2026 table yields 10 named closures and 2 New York early closes, ignoring settlement tables',()=>{
  const calendar=parse(`${html}<h2>TradeDate—Settlement Date Schedule</h2><table><tr><th>2026</th><th>Holiday</th><th>Status</th></tr><tr><td>November 23, 2026</td><td>Settlement only</td><td>Closed</td></tr></table>`);
  assert.equal(calendar.closedDates.length,10);
  assert.equal(Object.keys(calendar.holidayNames).length,10);
  assert.equal(calendar.holidayNames['2026-11-26'],'Thanksgiving Day - U.S.');
  assert.deepEqual(calendar.earlyCloses,{'2026-11-27':'13:00','2026-12-24':'13:00'});
  assert(!calendar.closedDates.includes('2026-11-23'));
});
for(const [name,change] of [
  ['missing year',source=>source.replaceAll('2026','2027')],
  ['duplicate annual table',source=>source+source],
  ['missing row',source=>source.replace(/<tr><td>January 19[\s\S]*?<\/tr>/,'')],
  ['duplicate date',source=>source.replace('January 19, 2026','January 1, 2026')],
  ['invalid date',source=>source.replace('February 16, 2026','February 30, 2026')],
  ['wrong row year',source=>source.replace('February 16, 2026','February 16, 2027')],
  ['unknown status',source=>source.replace('Closed','Unconfirmed')],
  ['empty name',source=>source.replace('Thanksgiving Day - U.S.','')],
  ['wrong headers',source=>source.replace('Status','Settlement')],
  ['unknown time',source=>source.replace('1:00 p.m.','Unknown')],
  ['merged cells',source=>source.replace('<td>January','<td colspan="2">January')],
  ['missing row cell',source=>source.replace('<td>Closed</td>','')]
]) test(`Parser rejects ${name} and updater leaves old file byte-for-byte intact`,async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'nasdaq-invalid-'));
  const file=path.join(directory,'nasdaq-2026.json'), original=JSON.stringify(parse(),null,2);
  try {
    await writeFile(file,original);
    await assert.rejects(updateCalendar({year:2026,outputDirectory:directory,html:change(html),verifiedOn:'2026-11-21'}));
    assert.equal(await readFile(file,'utf8'),original);
  } finally {await rm(directory,{recursive:true,force:true});}
});
test('HTTP errors preserve the old file and repeated normalized data does not change verification time',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'nasdaq-stable-'));
  try {
    const first=await updateCalendar({year:2026,outputDirectory:directory,html,verifiedOn:'2026-11-21'});
    const original=await readFile(first.filename,'utf8');
    await assert.rejects(updateCalendar({year:2026,outputDirectory:directory,fetch:async()=>({ok:false,status:503})}),/HTTP 503/);
    assert.equal(await readFile(first.filename,'utf8'),original);
    const again=await updateCalendar({year:2026,outputDirectory:directory,html:html.replaceAll('<td>','<td>  '),verifiedOn:'2026-11-22'});
    assert.equal(again.changed,false);
    assert.equal(await readFile(first.filename,'utf8'),original);
    const renamed=await updateCalendar({year:2026,outputDirectory:directory,html:html.replace('Thanksgiving Day - U.S.','Thanksgiving (updated name)'),verifiedOn:'2026-11-22'});
    assert.equal(renamed.changed,true);
    const changedTime=await updateCalendar({year:2026,outputDirectory:directory,html:html.replaceAll('1:00 p.m.','2:00 p.m.'),verifiedOn:'2026-11-22'});
    assert.equal(changedTime.calendar.earlyCloses['2026-11-27'],'14:00');
  } finally {await rm(directory,{recursive:true,force:true});}
});
test('Reordered JSON keys and dates do not count as a calendar change',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'nasdaq-order-'));
  try {
    const previous=parse();
    previous.closedDates.reverse();
    const reordered=Object.fromEntries(Object.entries(previous).reverse());
    await writeFile(path.join(directory,'nasdaq-2026.json'),JSON.stringify(reordered));
    assert.equal((await updateCalendar({year:2026,outputDirectory:directory,html,verifiedOn:'2026-11-22'})).changed,false);
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('Verified exceptional closures are merged and retained separately from the annual source',()=>{
  const exceptions=JSON.parse(requireText);
  const base={...parse(),year:2025,closedDates:['2025-01-01'],holidayNames:{'2025-01-01':"New Year's Day"},earlyCloses:{}};
  const merged=mergeExceptions(base,exceptions);
  assert(merged.closedDates.includes('2025-01-09'));
  assert.match(merged.holidayNames['2025-01-09'],/Jimmy Carter/);
  assert.match(merged.exceptionSources['2025-01-09'],/^https:\/\/ir.nasdaq.com\//);
  assert.deepEqual(mergeExceptions(merged,exceptions),merged);
});
const requireText=await readFile(new URL('./nasdaq-calendar-exceptions.json',import.meta.url),'utf8');
test('An update cannot silently discard a previously verified exceptional closure',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'nasdaq-exception-'));
  try {
    const previous=parse();
    previous.closedDates.push('2026-11-23');
    previous.exceptionSources={'2026-11-23':'https://www.nasdaqtrader.com/TraderNews.aspx?id=TEST'};
    const file=path.join(directory,'nasdaq-2026.json');
    await writeFile(file,JSON.stringify(previous));
    await assert.rejects(updateCalendar({year:2026,outputDirectory:directory,html,exceptions:{},verifiedOn:'2026-11-21'}),/remove a verified exception/);
  }finally{await rm(directory,{recursive:true,force:true});}
});
