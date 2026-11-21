(function (root) {
  'use strict';
  async function dispatch({ config, year, fetch: fetcher = root.fetch.bind(root) }) {
    if (!/^\d{4}$/.test(String(year)) || Number(year) < 1998 || Number(year) > 9998) throw new Error('YEAR');
    if (!config || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repo || '') ||
        !config.branch?.trim() || !config.token?.trim()) throw new Error('CONFIG');
    const repo = config.repo.split('/').map(encodeURIComponent).join('/');
    let response;
    try {
      response = await fetcher(`https://api.github.com/repos/${repo}/actions/workflows/update-nasdaq-calendar.yml/dispatches`, {
        method: 'POST',
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${config.token.trim()}`, 'X-GitHub-Api-Version': '2026-03-10', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: config.branch.trim(), inputs: { year: String(year) } })
      });
    } catch { throw new Error('NETWORK'); }
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    let body;
    if (response.status !== 204) { try { body = await response.json(); } catch {} }
    const runId = body?.workflow_run_id ?? body?.id;
    return { url: /^\d+$/.test(String(runId))
      ? `https://github.com/${repo}/actions/runs/${runId}`
      : `https://github.com/${repo}/actions/workflows/update-nasdaq-calendar.yml` };
  }
  root.NasdaqCalendarAdmin = { dispatch };
})(globalThis);
