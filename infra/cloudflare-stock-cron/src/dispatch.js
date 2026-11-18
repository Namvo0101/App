export const CRON = '13 0 * * TUE-SAT';
export const WORKFLOW_URL = 'https://github.com/Namvo0101/App/actions/workflows/update-stock-prices.yml';
const DISPATCH_URL = 'https://api.github.com/repos/Namvo0101/App/actions/workflows/update-stock-prices.yml/dispatches';
const FAILURE_HINTS = {
  401: 'GitHub rejected GITHUB_TOKEN. Check whether the PAT is valid and unexpired.',
  403: 'GitHub denied access. Check PAT repository selection, Actions write permission, approval and rate limits.',
  404: 'GitHub could not access Namvo0101/App or update-stock-prices.yml. Check PAT repository access and workflow location.',
  422: 'GitHub rejected the dispatch. Check that main exists and the workflow on main has workflow_dispatch.',
  429: 'GitHub rate limit reached. Check GitHub limits before trying again.'
};

// Log only validated run identifiers and fixed destination URLs, never response text.
function runDetails(body) {
  const rawId = body?.workflow_run_id ?? body?.id;
  const runId = (typeof rawId === 'string' && /^[1-9]\d*$/.test(rawId)) ||
    (Number.isSafeInteger(rawId) && rawId > 0) ? String(rawId) : null;
  const htmlUrl = typeof body?.html_url === 'string' &&
    /^https:\/\/github\.com\/Namvo0101\/App\/actions\/runs\/[1-9]\d*$/.test(body.html_url) ? body.html_url : null;
  const apiUrl = typeof body?.run_url === 'string' &&
    /^https:\/\/api\.github\.com\/repos\/Namvo0101\/App\/actions\/runs\/[1-9]\d*$/.test(body.run_url) ? body.run_url : null;
  return { run_id: runId, run_url: htmlUrl ?? apiUrl };
}

export async function dispatchWorkflow(controller, env, {
  fetchImpl = globalThis.fetch,
  logger = console,
  now = () => new Date()
} = {}) {
  const scheduledDate = new Date(controller.scheduledTime);
  const context = {
    triggered_at: now().toISOString(),
    scheduled_at: Number.isFinite(scheduledDate.getTime()) ? scheduledDate.toISOString() : null,
    cron: CRON,
    repository: 'Namvo0101/App',
    workflow: 'update-stock-prices.yml',
    ref: 'main'
  };
  const fail = (code, message, status = null) => {
    logger.error(JSON.stringify({ event: 'dispatch_failed', ...context, code, http_status: status, message }));
    // Throw a sanitized error so the scheduled invocation is marked as failed.
    throw new Error(`${code}: ${message}`);
  };

  logger.log(JSON.stringify({ event: 'cron_triggered', ...context }));
  if (controller.cron !== CRON) {
    fail('UNEXPECTED_CRON', 'This handler only accepts the configured 13 0 * * TUE-SAT schedule.');
  }
  if (typeof env?.GITHUB_TOKEN !== 'string' || !env.GITHUB_TOKEN.trim()) {
    fail('MISSING_SECRET', 'Configure the Cloudflare Worker secret GITHUB_TOKEN before running this handler.');
  }

  let response;
  try {
    response = await fetchImpl(DISPATCH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Namvo0101-App-stock-prices-cron',
        'X-GitHub-Api-Version': '2026-03-10'
      },
      body: JSON.stringify({ ref: 'main' }),
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000)
    });
  } catch {
    fail('GITHUB_NETWORK_ERROR', 'GitHub request failed, timed out or redirected. Check GitHub Actions before retrying: dispatch may already have been accepted.');
  }

  if (!response.ok) {
    fail('GITHUB_REJECTED', FAILURE_HINTS[response.status] ??
      'GitHub returned an unexpected failure. Check GitHub service status and repository Actions settings.', response.status);
  }

  let details = { run_id: null, run_url: null };
  if (response.status !== 204) {
    try { details = runDetails(await response.json()); } catch { /* Accepted without readable run details. */ }
  }
  const result = {
    event: 'dispatch_accepted', ...context, http_status: response.status, ...details,
    workflow_url: WORKFLOW_URL,
    message: 'GitHub accepted the dispatch. Workflow completion and price publication must be checked separately.'
  };
  logger.log(JSON.stringify(result));
  return result;
}

