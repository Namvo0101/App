import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

export async function createPage(filename, history, feed, saved = {}, options = {}) {
  const html = await readFile(new URL(`../${filename}`, import.meta.url), 'utf8');
  const helper = await readFile(new URL('../stock-price-sync.js', import.meta.url), 'utf8');
  const inline = html.match(/  <script>([\s\S]*?)  <\/script>/)?.[1];
  if (!inline) throw new Error('Page inline script not found');
  const elements = new Map();
  const storage = new Map(Object.entries(saved));
  const pageData = { history: structuredClone(history), feed: structuredClone(feed), offline: false, noFeed: false, requests: [] };
  const callbacks = {};
  const intervals = [];
  const PageDate = options.now ? class extends Date {
    constructor(...args) { super(...(args.length ? args : [Date.parse(options.now)])); }
    static now() { return Date.parse(options.now); }
  } : Date;
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const classes = new Set(['hidden']);
    let innerHTML = '';
    const el = {
      value: '', textContent: '', children: [], handlers: {}, style: {},
      classList: {
        contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name),
        toggle: name => classes.has(name) ? classes.delete(name) : classes.add(name)
      },
      get innerHTML() { return innerHTML; },
      set innerHTML(value) { innerHTML = value; this.children = []; },
      addEventListener(name, handler) { this.handlers[name] = handler; },
      querySelector: selector => element(selector.replace(/^#/, '')),
      appendChild(child) { this.children.push(child); },
      removeChild() {}, setAttribute(name, value) { this[name] = value; },
      removeAttribute(name) { delete this[name]; },
      matches() { return false; }, scrollIntoView() {}, focus() {}
    };
    elements.set(id, el);
    return el;
  }
  const context = vm.createContext({
    console,
    Date: PageDate,
    window: { addEventListener: (name, callback) => { callbacks[name] = callback; } },
    document: {
      getElementById: element, querySelectorAll: () => [], createElement: () => element(Symbol()),
      body: element('body'), activeElement: null, hidden: false,
      addEventListener: (name, callback) => { callbacks[`document:${name}`] = callback; }
    },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)
    },
    fetch: async url => {
      pageData.requests.push(String(url));
      await pageData.beforeResponse?.(String(url));
      if (pageData.offline) throw new Error('Offline test');
      if (String(url).split('?')[0] === './history_data.json') return { ok: true, json: async () => structuredClone(pageData.history) };
      if (String(url).split('?')[0] === './market_prices.json') {
        if (pageData.feedOffline) throw new Error('Price feed offline');
        return pageData.noFeed ? { ok: false, status: 404 }
          : { ok: true, json: async () => structuredClone(pageData.feed) };
      }
      throw new Error(`Unexpected page request: ${url}`);
    },
    lucide: { createIcons() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: (callback, milliseconds) => { intervals.push({ callback, milliseconds }); return 0; }
  });
  if (!options.missingHelper) vm.runInContext(helper, context);
  if (options.legacyHelper) vm.runInContext('delete StockPriceSync.renderPriceBadges;', context);
  if (options.missingIcons) vm.runInContext('delete globalThis.lucide;', context);
  new vm.Script(inline, { filename });
  vm.runInContext(inline, context);
  // Price tables and history rendering use the application code, including initial load.
  vm.runInContext('renderTask1UI = () => {};', context);
  const run = code => vm.runInContext(code, context);
  const snapshot = () => JSON.parse(run('JSON.stringify({ sessions: task2Sessions, finalized: isTask2Finalized, meta: activeCycleMeta })'));
  return { html, data: pageData, element, run, snapshot, storage, intervals, callbacks, init: callbacks.DOMContentLoaded };
}
