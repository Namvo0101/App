(function (root) {
  'use strict';
  const WORKFLOW = 'update-nasdaq-calendar.yml';
  const STORAGE_KEY = 'NAV_ADMIN_NASDAQ_REQUEST';
  const validId = value => /^\d+$/.test(String(value)) && Number(value) > 0;
  const validRequestId = value => typeof value === 'string' && /^nav-[a-zA-Z0-9-]{8,80}$/.test(value);
  function validate(config, year) {
    if (!/^\d{4}$/.test(String(year)) || Number(year) < 1998 || Number(year) > 9998) throw new Error('YEAR');
    if (!config || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repo || '') ||
        !config.branch?.trim() || !config.token?.trim()) throw new Error('CONFIG');
  }
  function repositoryPath(repo) { return repo.split('/').map(encodeURIComponent).join('/'); }
  function runUrl(request) {
    const base = `https://github.com/${repositoryPath(request.repo)}/actions`;
    return validId(request.runId) ? `${base}/runs/${request.runId}` : `${base}/workflows/${WORKFLOW}`;
  }
  function requestId() {
    return `nav-${root.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
  }
  async function requestJson(config, suffix, { fetch: fetcher = root.fetch.bind(root), method = 'GET', body } = {}) {
    const controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
    let timer;
    try {
      const operation = (async () => {
        let response;
        try {
          response = await fetcher(`https://api.github.com/repos/${repositoryPath(config.repo)}/${suffix}`, {
            method, cache: 'no-store', signal: controller?.signal,
            headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${config.token.trim()}`, 'X-GitHub-Api-Version': '2026-03-10', ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {})
          });
        } catch { throw new Error('NETWORK'); }
        if (!response.ok) throw new Error(`HTTP_${response.status}`);
        if (response.status === 204) return null;
        try { return await response.json(); }
        catch { if (method === 'POST') return null; throw new Error('RESPONSE'); }
      })();
      return await Promise.race([operation, new Promise((_, reject) => {
        timer = root.setTimeout(() => { controller?.abort(); reject(new Error('NETWORK')); }, 15000);
      })]);
    } finally { root.clearTimeout(timer); }
  }
  async function dispatch({ config, year, requestId: correlation = requestId(), fetch: fetcher } = {}) {
    validate(config, year);
    if (!validRequestId(correlation)) throw new Error('REQUEST');
    const body = await requestJson(config, `actions/workflows/${WORKFLOW}/dispatches`, {
      fetch: fetcher, method: 'POST', body: { ref: config.branch.trim(), inputs: { year: String(year), request_id: correlation } }
    });
    const id = body?.workflow_run_id ?? body?.id;
    const result = { repo: config.repo, branch: config.branch.trim(), year: String(year), requestId: correlation, runId: validId(id) ? String(id) : null };
    return { ...result, url: runUrl(result) };
  }
  function assertRun(run, request) {
    if (!run || !validId(run.id) || String(run.id) !== String(request.runId) || run.head_branch !== request.branch ||
        run.event !== 'workflow_dispatch' || run.path?.split('@')[0] !== `.github/workflows/${WORKFLOW}`) throw new Error('RESPONSE');
  }
  async function inspect({ config, request, fetch: fetcher } = {}) {
    validate(config, request.year);
    if (config.repo.toLowerCase() !== request.repo.toLowerCase()) throw new Error('CONFIG_CHANGED');
    let record = { ...request };
    if (!validId(record.runId)) {
      if (!validRequestId(record.requestId)) throw new Error('RESPONSE');
      const list = await requestJson(config, `actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&branch=${encodeURIComponent(record.branch)}&per_page=100`, { fetch: fetcher });
      if (!Array.isArray(list?.workflow_runs)) throw new Error('RESPONSE');
      // Correlate by the request's unique workflow title; never take the latest unrelated run.
      const matches = list.workflow_runs.filter(run => run.head_branch === record.branch && run.event === 'workflow_dispatch' &&
        typeof run.display_title === 'string' && run.display_title.includes(`[${record.requestId}]`));
      if (!matches.length) return { request: record, phase: 'locating', busy: true, done: false };
      if (matches.length !== 1 || !validId(matches[0].id)) throw new Error('RESPONSE');
      record.runId = String(matches[0].id);
    }
    const run = await requestJson(config, `actions/runs/${record.runId}`, { fetch: fetcher });
    assertRun(run, record);
    const detail = await requestJson(config, `actions/runs/${record.runId}/jobs?filter=latest&per_page=100`, { fetch: fetcher });
    if (!Array.isArray(detail?.jobs)) throw new Error('RESPONSE');
    const update = detail.jobs.find(job => job.name === 'update');
    const deploy = detail.jobs.find(job => job.name === 'deploy');
    const saved = update?.steps?.some(step => step.name === 'Commit only the requested calendar' && step.conclusion === 'success') || false;
    const result = { request: record, saved, busy: true, done: false, phase: 'queued' };
    if (run.status === 'completed') {
      if (run.conclusion !== 'success') return { ...result, phase: run.conclusion === 'cancelled' ? 'cancelled' : 'failed', busy: false, done: true };
      if (update?.conclusion === 'success' && deploy?.conclusion === 'success') return { ...result, saved: true, phase: 'success', busy: false, done: true };
      if (update?.conclusion === 'success' && deploy?.conclusion === 'skipped') return { ...result, saved: true, phase: 'saved_only', busy: false, done: true };
      return { ...result, phase: 'verifying' };
    }
    if (saved || deploy?.status === 'in_progress') return { ...result, phase: 'deploying' };
    if (run.status === 'in_progress' || update?.status === 'in_progress') return { ...result, phase: 'updating' };
    return result;
  }
  function statusText(state) {
    const year = state.request?.year || '';
    const messages = {
      sending: `Đang gửi yêu cầu cập nhật lịch Nasdaq ${year}…`,
      locating: `Đã gửi yêu cầu cho năm ${year}. Đang tìm lượt chạy tương ứng…`,
      queued: `Đã gửi yêu cầu cho năm ${year}. Đang chờ GitHub Actions chạy…`,
      updating: `Đang kiểm tra và cập nhật lịch Nasdaq ${year}…`,
      deploying: `Lịch Nasdaq ${year} đã lưu trên GitHub. Đang phát hành lên website…`,
      verifying: `Lượt chạy năm ${year} đã kết thúc. Đang xác minh kết quả cập nhật và phát hành…`,
      success: `Thành công: lịch Nasdaq ${year} đã cập nhật và phát hành lên website. Bấm Tính lại để dùng lịch mới.`,
      saved_only: `Lịch Nasdaq ${year} đã lưu trên GitHub, nhưng bước phát hành website được bỏ qua. Kiểm tra nhánh của lượt chạy.`,
      failed: state.saved ? `Lịch Nasdaq ${year} đã lưu trên GitHub, nhưng bước xử lý tiếp theo hoặc phát hành thất bại. Mở GitHub Actions để xem lỗi.` : `Cập nhật lịch Nasdaq ${year} thất bại. Mở GitHub Actions để xem bước bị lỗi.`,
      cancelled: `Lượt cập nhật lịch Nasdaq ${year} đã bị hủy.${state.saved ? ' File lịch đã được lưu nhưng chưa xác nhận phát hành.' : ''}`,
      retrying: 'Tạm mất kết nối theo dõi. Đang thử kiểm tra lại; chưa xác định kết quả workflow.',
      unknown: 'Chưa xác định được kết quả. Nhấn Kiểm tra trạng thái hoặc mở GitHub Actions; yêu cầu cập nhật không được tự gửi lại.',
      timeout: 'Đã dừng theo dõi tự động sau 30 phút. Workflow có thể vẫn chạy; nhấn Kiểm tra trạng thái để tiếp tục.'
    };
    const errors = {
      YEAR: 'Năm lịch không hợp lệ. Nhập năm từ 1998 đến 9998.',
      CONFIG: 'Thiếu cấu hình GitHub. Kiểm tra repository, nhánh và token trong phần cài đặt Git.',
      CONFIG_CHANGED: 'Cấu hình repository đã thay đổi. Mở liên kết lượt chạy cũ để kiểm tra kết quả.',
      HTTP_401: 'Token GitHub không hợp lệ hoặc đã hết hạn. Cập nhật token rồi nhấn Kiểm tra trạng thái.',
      HTTP_403: 'Không có quyền truy cập hoặc đã chạm giới hạn GitHub API. Kiểm tra quyền Actions của token rồi thử Kiểm tra trạng thái.',
      HTTP_404: 'Không tìm thấy workflow/lượt chạy hoặc token không có quyền đọc. Kiểm tra cấu hình và liên kết GitHub Actions.',
      HTTP_422: 'GitHub không chấp nhận yêu cầu. Kiểm tra năm, nhánh và bảo đảm workflow mới có khai báo request_id.'
    };
    if (state.phase === 'error') return errors[state.error] || 'Không gửi được yêu cầu cập nhật. Kiểm tra GitHub Actions trước khi gửi lại.';
    if (state.phase === 'unknown' && errors[state.error]) return `Chưa xác định được kết quả. ${errors[state.error]}`;
    return messages[state.phase] || messages.unknown;
  }
  function createTracker({ getConfig, onChange, storage = root.localStorage, fetch: fetcher,
    setTimer = root.setTimeout.bind(root), clearTimer = root.clearTimeout.bind(root), now = Date.now,
    intervalMs = 5000, maxTrackingMs = 30 * 60 * 1000 } = {}) {
    let record = null, generation = 0, timer = null, checking = false, sending = false, failures = 0, started = now();
    function persist() {
      try { if (record) storage?.setItem(STORAGE_KEY, JSON.stringify(record)); else storage?.removeItem(STORAGE_KEY); } catch {}
    }
    function publish(state) {
      const result = { request: record, url: record ? runUrl(record) : null, ...state };
      onChange({ ...result, text: statusText(result) });
    }
    function cancelTimer() { if (timer !== null) clearTimer(timer); timer = null; }
    function stop() { generation++; cancelTimer(); checking = false; sending = false; }
    async function check() {
      if (!record || checking || sending) return;
      cancelTimer(); checking = true;
      const version = generation;
      try {
        const state = await inspect({ config: getConfig(), request: record, fetch: fetcher });
        if (version !== generation) return;
        record = state.request; persist(); failures = 0;
        publish(state);
        if (!state.done) {
          if (now() - started >= maxTrackingMs) publish({ phase: 'timeout', busy: false });
          else timer = setTimer(() => { void check(); }, intervalMs);
        }
      } catch (error) {
        if (version !== generation) return;
        failures++;
        const retryable = error.message === 'NETWORK' || error.message === 'RESPONSE' || /^HTTP_5\d\d$/.test(error.message) || error.message === 'HTTP_429';
        if (retryable && failures < 3 && now() - started < maxTrackingMs) {
          publish({ phase: 'retrying', busy: true });
          timer = setTimer(() => { void check(); }, intervalMs);
        } else publish({ phase: 'unknown', error: error.message, busy: false });
      } finally { if (version === generation) checking = false; }
    }
    async function start(year) {
      if (sending || checking || timer !== null) return;
      const config = { ...getConfig() };
      try { validate(config, year); } catch (error) { publish({ phase: 'error', error: error.message, busy: false }); return; }
      stop(); started = now(); failures = 0; sending = true;
      const version = generation;
      record = { repo: config.repo, branch: config.branch.trim(), year: String(year), requestId: requestId(), runId: null };
      persist(); publish({ phase: 'sending', busy: true });
      try {
        const result = await dispatch({ config, year, requestId: record.requestId, fetch: fetcher });
        if (version !== generation) return;
        record = { repo: result.repo, branch: result.branch, year: result.year, requestId: result.requestId, runId: result.runId };
        persist(); sending = false; publish({ phase: 'locating', busy: true });
        await check();
      } catch (error) {
        if (version !== generation) return;
        sending = false;
        if (error.message === 'NETWORK') publish({ phase: 'unknown', error: error.message, busy: false });
        else { record = null; persist(); publish({ phase: 'error', error: error.message, busy: false }); }
      }
    }
    async function resume() { if (!record) return; started = now(); failures = 0; await check(); }
    async function restore() {
      let saved;
      try { saved = JSON.parse(storage?.getItem(STORAGE_KEY) || 'null'); } catch { return; }
      if (!saved || typeof saved.repo !== 'string' || typeof saved.branch !== 'string' ||
          !/^\d{4}$/.test(String(saved.year)) || (!validId(saved.runId) && !validRequestId(saved.requestId))) return;
      // Retain only request metadata, never credentials or persisted response messages.
      record = { repo: saved.repo, branch: saved.branch, year: String(saved.year), requestId: validRequestId(saved.requestId) ? saved.requestId : null, runId: validId(saved.runId) ? String(saved.runId) : null };
      publish({ phase: 'locating', busy: true });
      await resume();
    }
    return { start, resume, restore, stop };
  }
  root.NasdaqCalendarAdmin = { dispatch, inspect, statusText, createTracker, STORAGE_KEY };
})(globalThis);
