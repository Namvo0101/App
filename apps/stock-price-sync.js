(function (root) {
  'use strict';

  function price(value) {
    if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function signature(cycle) {
    return (cycle?.sessions || []).map(s => `${s.sessionNumber}:${s.dateIso}`).join('|');
  }

  function matches(cycle, feed) {
    return !!(cycle?.id && feed?.schemaVersion === 1 && cycle.id === feed.cycleId
      && String(cycle.ticker).toUpperCase() === feed.ticker
      && (cycle.updatedAt || null) === (feed.cycleRevision || null)
      && signature(cycle) === feed.scheduleKey && Array.isArray(feed.sessions));
  }

  function mergeSession(cycle, published, local, feed) {
    const apiRow = matches(cycle, feed)
      ? feed.sessions.find(s => s.dateIso === published.dateIso && s.sessionNumber === published.sessionNumber)
      : null;
    const adminValue = price(published.price);
    const localValue = price(local?.price);
    const apiValue = price(apiRow?.price);
    // Inherited Admin locks must disappear when Admin unlocks the row.
    const userLocked = !!(local?.locked && !local.masterLocked);
    const locked = !!(published.locked || userLocked);
    let value = local && !local.masterLocked ? localValue : adminValue;
    let source = local?.manualOverride ? 'manual' : local?.source || 'admin';
    if (cycle.isFinalized || (published.locked && adminValue !== null)) {
      value = adminValue;
      source = 'admin';
    } else if (cycle.userFinalized && local) {
      value = localValue;
    } else if (locked && local?.locked && localValue !== null) {
      value = localValue;
    } else if (apiValue !== null) {
      // Open rows and empty locked rows take API prices, even after a manual edit/clear.
      value = apiValue;
      source = 'api';
    }
    return {
      sessionNumber: published.sessionNumber,
      dateIso: published.dateIso,
      price: value,
      locked,
      masterLocked: !!published.locked,
      manualOverride: source === 'manual',
      source
    };
  }

  async function fetchFeed() {
    const response = await root.fetch(`./market_prices.json?v=${Date.now()}`, { cache: 'no-store' });
    if (response.status === 404) return { schemaVersion: 1, sessions: [] };
    if (!response.ok) throw new Error('Price feed unavailable');
    const feed = await response.json();
    if (feed.schemaVersion !== 1 || !Array.isArray(feed.sessions)) throw new Error('Invalid price feed');
    return feed;
  }

  function renderStatus(element, cycle, sessions, feed, lang, unavailable) {
    if (!element) return;
    const vi = lang === 'vi';
    const count = sessions.filter(s => price(s.price) !== null).length;
    let text = cycle
      ? (vi ? `${count}/${sessions.length} phiên có giá` : `${count}/${sessions.length} sessions with prices`)
      : (vi ? 'Chưa có chu kỳ đang theo dõi' : 'No active cycle');
    const datedPrices = sessions.filter(s => price(s.price) !== null)
      .map(s => s.dateIso || s.date?.toISOString?.().slice(0, 10)).filter(Boolean).sort();
    if (datedPrices.length) text += ` · ${vi ? 'Phiên gần nhất' : 'Latest session'}: ${datedPrices.at(-1)}`;
    if (cycle?.isFinalized) text += vi ? ' · Đã chốt bởi Admin' : ' · Finalized by Admin';
    if (matches(cycle, feed) && feed.updatedAt) {
      const time = new Date(feed.updatedAt);
      if (!isNaN(time)) text += ` · Alpha Vantage: ${new Intl.DateTimeFormat(vi ? 'vi-VN' : 'en-GB', {
        timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'short', timeStyle: 'short'
      }).format(time)}`;
    } else if (cycle && !cycle.isFinalized) {
      text += sessions.length && sessions.every(s => s.locked)
        ? (vi ? ' · Các phiên đã khóa' : ' · All sessions are locked')
        : (vi ? ' · Đang chờ giá tự động cho kỳ này' : ' · Waiting for automatic prices for this cycle');
    }
    if (unavailable) text += vi ? ' · Chưa tải được dữ liệu mới; giữ dữ liệu hiện có' : ' · Update unavailable; keeping current data';
    element.textContent = text;
    const reset = root.document?.getElementById('btn-reset-market-prices');
    if (reset) reset.title = vi ? 'Điền giá API vào các ô đang mở hoặc còn trống' : 'Apply API prices to open or empty cells';
  }

  const api = { price, signature, matches, mergeSession, fetchFeed, renderStatus };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.StockPriceSync = api;
})(globalThis);
