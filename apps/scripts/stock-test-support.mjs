export function makeCycle() {
  const sessions = [];
  const date = new Date('2026-10-19T00:00:00Z');
  while (sessions.length < 20) {
    if (![0, 6].includes(date.getUTCDay())) {
      sessions.push({ sessionNumber: sessions.length + 1, dateIso: date.toISOString().slice(0, 10), price: null, locked: false });
    }
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return {
    id: '2026-Q4-2026-10-19-2026-11-13', ticker: 'ARM', quarter: 4, year: 2026,
    startDate: sessions[0].dateIso, endDate: sessions.at(-1).dateIso,
    updatedAt: '2026-10-18T10:00:00.000Z', isFinalized: false, sessions
  };
}

export function apiResponse(cycle, entries) {
  return {
    'Meta Data': { '2. Symbol': cycle.ticker },
    'Time Series (Daily)': Object.fromEntries(entries.map(([date, value]) => [date, { '4. close': String(value) }]))
  };
}
