import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE = 'https://www.nasdaqtrader.com/trader.aspx?id=calendar';
const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
export function calendarYear(value) {
  if (!/^\d{4}$/.test(String(value)) || +value < 1998 || +value > 9998) throw new Error('Calendar year must be a four-digit year from 1998 to 9998.');
  return Number(value);
}
function text(html) {
  const entities = { nbsp:' ', amp:'&', quot:'"', apos:"'", lt:'<', gt:'>', rsquo:'’', lsquo:'‘', ndash:'–', mdash:'—' };
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]*>/g, ' ').replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (_, entity) => {
      if (entity.startsWith('#')) {
        const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2),16) : Number(entity.slice(1));
        if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) throw new Error('Invalid HTML entity.');
        return String.fromCodePoint(code);
      }
      if (!(entity.toLowerCase() in entities)) throw new Error('Unknown HTML entity in calendar.');
      return entities[entity.toLowerCase()];
    }).replace(/\s+/g,' ').trim();
}
function validIso(iso, year) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !iso.startsWith(`${year}-`)) throw new Error('Calendar date is outside the requested year.');
  const date = new Date(`${iso}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== iso) throw new Error('Invalid calendar date.');
  return iso;
}
function parseDay(value, year) {
  const match = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(value);
  if (!match || !months.includes(match[1]) || +match[3] !== year) throw new Error('Unrecognized date or wrong year in Nasdaq table.');
  return validIso(`${year}-${String(months.indexOf(match[1])+1).padStart(2,'0')}-${match[2].padStart(2,'0')}`,year);
}
function parseTime(value) {
  const match = /^(?:Early Close\s*[-–:]?\s*)?([1-9]|1[0-2]):([0-5]\d)\s*([ap])\.?m\.?(?:\s*(?:ET|Eastern Time))?\*?$/i.exec(value);
  if (!match) throw new Error('Unknown early-close time.');
  const hour = +match[1] % 12 + (match[3].toLowerCase() === 'p' ? 12 : 0);
  return `${String(hour).padStart(2,'0')}:${match[2]}`;
}
const sorted = object => Object.fromEntries(Object.entries(object).sort(([a],[b]) => a.localeCompare(b)));
export function parseNasdaqCalendar(html, requestedYear, verifiedOn) {
  const year=calendarYear(requestedYear);
  const cleaned=html.replace(/<!--[\s\S]*?-->/g,'').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'');
  const headings=[...cleaned.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)];
  const candidates=[];
  for (let index=0;index<headings.length;index++) {
    const heading=text(headings[index][2]);
    if (!/U\.?S\.?\s+Equity and Options Markets? Holiday Schedule/i.test(heading)) continue;
    const headingYear=heading.match(/\b\d{4}\b/);
    if (headingYear && +headingYear[0] !== year) continue;
    const section=cleaned.slice(headings[index].index+headings[index][0].length,headings[index+1]?.index ?? cleaned.length);
    const tables=[...section.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)];
    for(const table of tables) {
      if (/<table\b/i.test(table[1])) throw new Error('Nested calendar table cannot be verified.');
      const rows=[...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)].map(row => {
        if (/\b(?:rowspan|colspan)\s*=/i.test(row[1])) throw new Error('Merged calendar cells cannot be verified.');
        return [...row[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]\s*>/gi)].map(cell=>text(cell[1]));
      });
      if (!rows.length) continue;
      const [dateHeader,holidayHeader,statusHeader]=rows[0];
      if (rows[0].length!==3 || holidayHeader!=='Holiday' || statusHeader!=='Status') continue;
      if (dateHeader!==String(year) && !(headingYear && /^Date$/i.test(dateHeader))) continue;
      candidates.push(rows.slice(1));
    }
  }
  if(candidates.length!==1) throw new Error(`Expected one verified U.S. Equity and Options calendar for ${year}; found ${candidates.length}. Existing file kept.`);
  const closedDates=[],holidayNames={},earlyCloses={},seen=new Set();
  for(const row of candidates[0]) {
    if(row.length!==3 || row.some(cell=>!cell)) throw new Error('Calendar row is incomplete.');
    const [day,name,status]=row, iso=parseDay(day,year);
    if(seen.has(iso)) throw new Error('Duplicate date in Nasdaq calendar.');
    seen.add(iso);
    if(/^Closed\*?$/i.test(status)) {closedDates.push(iso); holidayNames[iso]=name;}
    else if(/^Early Close\b/i.test(name) || /^Early Close\b/i.test(status)) earlyCloses[iso]=parseTime(status);
    else throw new Error('Unknown trading status in Nasdaq calendar.');
  }
  // Detect a truncated annual table; do not infer any missing dates from fallback rules.
  const minimumClosed=(year>=2022?10:9)-(new Date(Date.UTC(year,0,1)).getUTCDay()===6?1:0);
  if(closedDates.length<minimumClosed || closedDates.length>40 || Object.keys(earlyCloses).length<1 ||
      !closedDates.some(day=>day.slice(5,7)==='01') || !closedDates.some(day=>day.slice(5,7)==='12')) throw new Error('Annual Nasdaq calendar appears incomplete.');
  validIso(verifiedOn,Number(verifiedOn?.slice(0,4)));
  return { exchange:'NASDAQ',year,timeZone:'America/New_York',source:SOURCE,verifiedOn,closedDates:closedDates.sort(),holidayNames:sorted(holidayNames),earlyCloses:sorted(earlyCloses) };
}
export function mergeExceptions(calendar, exceptions={}) {
  const dates=new Set(calendar.closedDates), holidayNames={...calendar.holidayNames}, exceptionSources={};
  for(const entry of exceptions[String(calendar.year)] || []) {
    const iso=validIso(entry.date,calendar.year);
    if(typeof entry.name!=='string'||!entry.name.trim()||typeof entry.source!=='string'||!/^https:\/\/(?:www\.|ir\.)?nasdaq(?:trader)?\.com\//.test(entry.source)) throw new Error('Verified exception needs a Nasdaq source and name.');
    if(calendar.earlyCloses[iso]) throw new Error('Exception conflicts with an early close.');
    if(exceptionSources[iso]) throw new Error('Duplicate calendar exception.');
    dates.add(iso); holidayNames[iso]=entry.name.trim(); exceptionSources[iso]=entry.source;
  }
  const merged={...calendar,closedDates:[...dates].sort(),holidayNames:sorted(holidayNames)};
  if(Object.keys(exceptionSources).length) merged.exceptionSources=sorted(exceptionSources);
  return merged;
}
function semanticContent(calendar) {
  const {verifiedOn,...rest}=calendar;
  const stable=value => Array.isArray(value)?value.map(stable):value && typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,stable(item)])):value;
  return JSON.stringify(stable({...rest,closedDates:[...rest.closedDates].sort(),holidayNames:rest.holidayNames||{},earlyCloses:rest.earlyCloses||{},exceptionSources:rest.exceptionSources||{}}));
}
export async function updateCalendar({ year: requestedYear, outputDirectory=new URL('../market-calendars/',import.meta.url), fetch:fetcher=fetch, verifiedOn=new Date().toISOString().slice(0,10), exceptions, html }={}) {
  const year=calendarYear(requestedYear);
  if(exceptions===undefined) exceptions=JSON.parse(await readFile(new URL('./nasdaq-calendar-exceptions.json',import.meta.url),'utf8'));
  if(html===undefined) {
    const response=await fetcher(SOURCE,{signal:AbortSignal.timeout(25000)});
    if(!response.ok) throw new Error(`Nasdaq calendar HTTP ${response.status}; existing file kept.`);
    html=await response.text();
  }
  const calendar=mergeExceptions(parseNasdaqCalendar(html,year,verifiedOn),exceptions);
  const directory=outputDirectory instanceof URL?fileURLToPath(outputDirectory):path.resolve(outputDirectory);
  const filename=path.join(directory,`nasdaq-${year}.json`);
  let previous;
  try { previous=JSON.parse(await readFile(filename,'utf8')); } catch(error) { if(error.code!=='ENOENT') throw error; }
  if(previous) {
    for(const iso of Object.keys(previous.exceptionSources||{})) {
      if(!calendar.closedDates.includes(iso)) throw new Error('Update would remove a verified exception. Add it to the exception source first.');
    }
    if(semanticContent(previous)===semanticContent(calendar)) return {changed:false,calendar:previous,filename};
  }
  await mkdir(directory,{recursive:true});
  const temporary=`${filename}.${process.pid}.tmp`;
  try {await writeFile(temporary,`${JSON.stringify(calendar,null,2)}\n`,{flag:'wx'}); await rename(temporary,filename);}
  finally {await rm(temporary,{force:true});}
  return {changed:true,calendar,filename};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const result=await updateCalendar({year:process.argv[2]??process.env.CALENDAR_YEAR});
    console.log(`Nasdaq ${result.calendar.year}: ${result.calendar.closedDates.length} closed dates, ${Object.keys(result.calendar.earlyCloses).length} early closes; ${result.changed?'calendar changed (commit required)':'unchanged (no commit required)'}.`);
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
