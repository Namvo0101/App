(function (root) {
  'use strict';
  const TIME_ZONE = 'America/New_York';
  function parseDate(iso) {
    if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error('Invalid calendar date');
    const date = new Date(`${iso}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso) throw new Error('Invalid calendar date');
    return date;
  }
  const dateKey = date => date.toISOString().slice(0, 10);
  function newYorkDate(timestamp = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(timestamp);
    const value = type => parts.find(part => part.type === type).value;
    return `${value('year')}-${value('month')}-${value('day')}`;
  }
  function nthWeekday(year, month, weekday, n) {
    const first = new Date(Date.UTC(year, month, 1));
    return new Date(Date.UTC(year, month, 1 + (weekday - first.getUTCDay() + 7) % 7 + (n - 1) * 7));
  }
  function lastMonday(year, month) {
    const date = new Date(Date.UTC(year, month + 1, 0));
    date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
    return date;
  }
  function observed(year, month, day) {
    const date = new Date(Date.UTC(year, month, day));
    date.setUTCDate(date.getUTCDate() + (date.getUTCDay() === 6 ? -1 : date.getUTCDay() === 0 ? 1 : 0));
    return date;
  }
  function goodFriday(year) {
    const a = year % 19, b = Math.floor(year / 100), c = year % 100;
    const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    return new Date(Date.UTC(year, Math.floor((h + l - 7 * m + 114) / 31) - 1, (h + l - 7 * m + 114) % 31 - 1));
  }
  function fallbackHolidays(year) {
    const holidays = Object.create(null);
    const add = (date, en, vi) => { holidays[dateKey(date)] = { en, vi }; };
    const newYear = new Date(Date.UTC(year, 0, 1));
    // A Saturday New Year does not close the preceding Friday.
    if (newYear.getUTCDay() !== 6) add(observed(year, 0, 1), "New Year's Day", 'Tết Dương lịch');
    if (year >= 1998) add(nthWeekday(year, 0, 1, 3), 'Martin Luther King Jr. Day', 'Ngày Martin Luther King Jr.');
    add(nthWeekday(year, 1, 1, 3), "Presidents' Day", 'Ngày Tổng thống Mỹ');
    add(goodFriday(year), 'Good Friday', 'Thứ Sáu Tuần Thánh');
    add(lastMonday(year, 4), 'Memorial Day', 'Ngày Tưởng niệm Chiến sĩ trận vong');
    if (year >= 2022) add(observed(year, 5, 19), 'Juneteenth', 'Ngày Giải phóng Nô lệ (Juneteenth)');
    add(observed(year, 6, 4), 'Independence Day', 'Ngày Quốc khánh Mỹ (4/7)');
    add(nthWeekday(year, 8, 1, 1), 'Labor Day', 'Ngày Quốc tế Lao động Mỹ');
    add(nthWeekday(year, 10, 4, 4), 'Thanksgiving Day', 'Lễ Tạ ơn');
    add(observed(year, 11, 25), 'Christmas Day', 'Lễ Giáng sinh');
    return holidays;
  }
  function validateCalendar(data, year) {
    if (!data || data.year !== year || !Array.isArray(data.closedDates) || !data.closedDates.length ||
        (data.exchange !== undefined && data.exchange !== 'NASDAQ') ||
        (data.timeZone !== undefined && data.timeZone !== TIME_ZONE)) throw new Error('Invalid Nasdaq calendar');
    const validDate = iso => {
      if (parseDate(iso).getUTCFullYear() !== year) throw new Error('Calendar year mismatch');
    };
    const closedDates = new Set();
    for (const iso of data.closedDates) {
      validDate(iso);
      if (closedDates.has(iso)) throw new Error('Duplicate closed date');
      closedDates.add(iso);
    }
    const holidays = Object.create(null);
    const names = data.holidayNames;
    if (names !== undefined && (!names || typeof names !== 'object' || Array.isArray(names))) throw new Error('Invalid holiday names');
    for (const [iso, name] of Object.entries(names || {})) {
      if (!closedDates.has(iso) || typeof name !== 'string' || !name.trim()) throw new Error('Invalid holiday name');
    }
    for (const iso of closedDates) {
      const name = names?.[iso];
      holidays[iso] = name ? { en: name, vi: name } : { en: 'Nasdaq market holiday', vi: 'Ngày nghỉ giao dịch Nasdaq' };
    }
    const earlyCloses = data.earlyCloses ?? {};
    if (!earlyCloses || typeof earlyCloses !== 'object' || Array.isArray(earlyCloses)) throw new Error('Invalid early closes');
    for (const [iso, time] of Object.entries(earlyCloses)) {
      validDate(iso);
      if (closedDates.has(iso) || typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Invalid early close');
    }
    return { year, source: 'nasdaq', holidays, earlyCloses: { ...earlyCloses }, verifiedOn: data.verifiedOn || null };
  }
  function createYearLoader({ fetch: fetcher = root.fetch?.bind(root), timeoutMs = 10000 } = {}) {
    // Cache only within this calculation, so a deliberate recalculation can read newly published JSON.
    const years = new Map();
    return year => {
      if (!years.has(year)) years.set(year, (async () => {
        let timer;
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        try {
          const request = (async () => {
            const response = await fetcher(`./market-calendars/nasdaq-${year}.json`, { cache: 'no-store', signal: controller?.signal });
            if (!response.ok) throw new Error('Calendar unavailable');
            return validateCalendar(await response.json(), year);
          })();
          return await Promise.race([request, new Promise((_, reject) => {
            timer = setTimeout(() => { controller?.abort(); reject(new Error('Calendar timeout')); }, timeoutMs);
          })]);
        } catch {
          return { year, source: 'rule', holidays: fallbackHolidays(year), earlyCloses: {} };
        } finally { clearTimeout(timer); }
      })());
      return years.get(year);
    };
  }
  async function calculateCycle(target, { loadYear = createYearLoader() } = {}) {
    const targetDate = parseDate(target);
    const cursor = new Date(targetDate);
    const tradingSessions = [], skippedHolidays = [], sources = new Map(), earlyCloses = {};
    let weekendDaysCount = 0;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    while (tradingSessions.length < 20) {
      const year = cursor.getUTCFullYear(), iso = dateKey(cursor);
      if (!sources.has(year)) sources.set(year, await loadYear(year));
      const calendar = sources.get(year);
      if ([0, 6].includes(cursor.getUTCDay())) weekendDaysCount++;
      else if (calendar.holidays[iso]) skippedHolidays.push({ date: new Date(cursor), name: calendar.holidays[iso] });
      else {
        tradingSessions.unshift(new Date(cursor));
        if (calendar.earlyCloses[iso]) earlyCloses[iso] = calendar.earlyCloses[iso];
      }
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    const startDate = tradingSessions[0], endDate = tradingSessions.at(-1);
    return {
      targetDate, startDate, endDate, validEndTradingDay: endDate,
      year: endDate.getUTCFullYear(), quarter: Math.floor(endDate.getUTCMonth() / 3) + 1,
      tradingSessions, skippedHolidays, weekendDaysCount, holidaysCount: skippedHolidays.length, earlyCloses,
      calendarSources: [...sources.values()].map(({ year, source, verifiedOn }) => ({ year, source, verifiedOn })).sort((a, b) => a.year - b.year)
    };
  }
  function sourceText(result, lang) {
    if (!result?.calendarSources) return lang === 'vi' ? 'Chu kỳ đã lưu · Chưa tính lại theo lịch mới' : 'Saved cycle · Not recalculated';
    return result.calendarSources.map(({ year, source }) => source === 'nasdaq'
      ? `Nasdaq ${year}` : `${lang === 'vi' ? 'Lịch dự kiến' : 'Estimated calendar'} ${year}`).join(' · ');
  }
  function previewText(result, previousDates, lang) {
    if (!result?.calendarSources) return '';
    const dates = result.tradingSessions.map(dateKey);
    const lines = [dates.map((iso, i) => `${i + 1}. ${iso}${result.earlyCloses[iso] ? ` (${result.earlyCloses[iso]} ET)` : ''}`).join(' · ')];
    if (previousDates?.length) {
      const added = dates.filter(iso => !previousDates.includes(iso));
      const removed = previousDates.filter(iso => !dates.includes(iso));
      lines.push(`${lang === 'vi' ? 'So với chu kỳ đang mở — Thêm' : 'Compared with the open cycle — Added'}: ${added.join(', ') || '—'}`);
      lines.push(`${lang === 'vi' ? 'Bỏ' : 'Removed'}: ${removed.join(', ') || '—'}`);
    }
    return lines.join('\n');
  }
  function createPreviewController({ input, button, status, onResult, getLanguage }) {
    let version = 0, readyDate = null, pending = false;
    function invalidate() {
      version++;
      readyDate = null;
      pending = false;
      button.disabled = true;
    }
    async function calculate(iso) {
      invalidate();
      const request = version;
      pending = true;
      status.textContent = getLanguage() === 'vi' ? 'Đang tải lịch giao dịch…' : 'Loading market calendar…';
      try {
        const result = await calculateCycle(iso);
        if (request !== version || input.value !== iso) return null;
        pending = false;
        readyDate = iso;
        button.disabled = false;
        onResult(result);
        return result;
      } catch {
        if (request === version) {
          pending = false;
          status.textContent = getLanguage() === 'vi' ? 'Ngày chốt không hợp lệ. Hãy chọn lại ngày.' : 'Invalid cut-off date. Please choose a date.';
        }
        return null;
      }
    }
    return { calculate, invalidate, isPending: () => pending, canApply: result => !pending && readyDate === input.value && result && dateKey(result.targetDate) === readyDate };
  }
  root.MarketCalendar = { parseDate, dateKey, newYorkDate, fallbackHolidays, validateCalendar, createYearLoader, calculateCycle, sourceText, previewText, createPreviewController };
})(globalThis);
