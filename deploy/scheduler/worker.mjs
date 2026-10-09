// This Worker can only request the existing collection workflow. It never gets
// application, database or model credentials, and has no HTTP trigger.
const API_ORIGIN = 'https://api.github.com';
const REPOSITORY = 'lemon7500/pharma-radar';
const REF = 'main';
const WORKFLOW = 'pharma-collect.yml';
const COLLECTION_STEP = 'Process due sources and queued work';
const API_VERSION = '2022-11-28';
const ACTIVE_STATUSES = ['queued', 'in_progress', 'waiting', 'requested', 'pending'];
const RUN_STATUSES = new Set([...ACTIVE_STATUSES, 'completed']);
const CONCLUSIONS = new Set(['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale']);
const MIN_INTERVAL_MS = 55 * 60_000;
const STALE_ACTIVE_MS = 2 * 60 * 60_000;
const LOOKBACK_MS = 90 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_JSON_BYTES = 128 * 1024;
const RECENT_RUN_LIMIT = 10;

class SchedulerError extends Error {
  constructor(reason) {
    super(`Collection scheduler failed: ${reason}`);
    this.name = 'SchedulerError';
    this.reason = reason;
  }
}
const fail = reason => { throw new SchedulerError(reason); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = value => Number.isSafeInteger(value) && value > 0;
const repositoryPath = `/repos/${REPOSITORY}`;
const workflowPath = `${repositoryPath}/actions/workflows/${WORKFLOW}`;

function flag(value, defaultValue) {
  if (value === undefined) return defaultValue;
  if (value === 'true') return true;
  if (value === 'false') return false;
  fail('invalid_configuration');
}

function configuration(env) {
  const expected = {
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_OWNER: 'lemon7500',
    GITHUB_REPO: 'pharma-radar',
    GITHUB_REF: REF,
    GITHUB_API_URL: API_ORIGIN,
    WORKFLOW_FILE: WORKFLOW,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (env[key] !== undefined && env[key] !== value) fail('invalid_configuration');
  }
  const enabled = flag(env.ENABLE, false);
  const dryRun = flag(env.DRY_RUN, true);
  if (!enabled) return { enabled, dryRun };
  const token = env.GITHUB_TOKEN;
  if (typeof token !== 'string' || token.length < 20 || token.length > 256 || !/^[\x21-\x7e]+$/.test(token)) {
    fail('missing_or_invalid_token');
  }
  return { enabled, dryRun, token };
}

async function boundedJson(response) {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_JSON_BYTES)) {
    fail('github_response_too_large');
  }
  if (!response.body) fail('invalid_github_json');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) {
        await reader.cancel();
        fail('github_response_too_large');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SchedulerError) throw error;
    fail('github_response_unavailable');
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('invalid_github_json');
  }
}

async function github(fetchImpl, token, path, { method = 'GET', body } = {}) {
  // All callers use constants or validated numeric IDs. No binding can change
  // the origin or redirect an Authorization header to another service.
  const url = new URL(path, API_ORIGIN);
  if (url.origin !== API_ORIGIN || !url.pathname.startsWith(`${repositoryPath}/`)) fail('invalid_api_target');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let response;
    try {
      response = await fetchImpl(url.href, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': API_VERSION,
          'User-Agent': 'pharma-radar-collection-scheduler',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      fail(controller.signal.aborted ? 'github_timeout' : 'github_network_error');
    }
    if (response.status === 401) fail('github_authentication_failed');
    if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) fail('github_rate_limited');
    if (response.status === 403) fail('github_permission_denied');
    if (response.status === 404) fail('github_resource_unavailable');
    if (method === 'POST') {
      // Do not retry dispatch after an uncertain result: GitHub may already
      // have queued it. The next Cron check reads workflow state again.
      if (response.status === 204) return { dispatchId: null };
      if (response.status === 200) {
        const result = await boundedJson(response);
        const dispatchId = result?.workflow_run_id;
        if (!isObject(result) || !isId(dispatchId)) fail('invalid_dispatch_response');
        return { dispatchId };
      }
      fail('github_dispatch_rejected');
    }
    if (response.status !== 200) fail('github_request_rejected');
    return await boundedJson(response);
  } finally {
    clearTimeout(timer);
  }
}

function timestamp(value, now) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) fail('invalid_github_timestamp');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed > now + 5 * 60_000) fail('invalid_github_timestamp');
  return parsed;
}

function validateRun(run, workflowId, now) {
  if (!isObject(run) || !isId(run.id) || run.workflow_id !== workflowId || run.head_branch !== REF || !RUN_STATUSES.has(run.status)) fail('invalid_workflow_runs');
  if (run.repository?.full_name !== REPOSITORY) fail('invalid_workflow_runs');
  if (run.status === 'completed' ? !CONCLUSIONS.has(run.conclusion) : run.conclusion !== null) fail('invalid_workflow_runs');
  const created = timestamp(run.created_at, now);
  const started = run.run_started_at == null ? created : timestamp(run.run_started_at, now);
  if (started < created) fail('invalid_github_timestamp');
  return { ...run, activityTime: Math.max(created, started) };
}

function validateRunList(data, workflowId, now, limit) {
  if (!isObject(data) || !Number.isSafeInteger(data.total_count) || data.total_count < 0 || !Array.isArray(data.workflow_runs) || data.workflow_runs.length > limit) fail('invalid_workflow_runs');
  if (data.workflow_runs.length !== Math.min(data.total_count, limit)) fail('invalid_workflow_runs');
  const runs = data.workflow_runs.map(run => validateRun(run, workflowId, now));
  if (new Set(runs.map(run => run.id)).size !== runs.length) fail('invalid_workflow_runs');
  return runs;
}

function admittedStepTime(data, run, now) {
  if (isObject(data) && data.total_count === 0 && Array.isArray(data.jobs) && data.jobs.length === 0 && run.status === 'completed' && run.conclusion !== 'success') return null;
  if (!isObject(data) || !Number.isSafeInteger(data.total_count) || data.total_count < 1 || data.total_count > 10 || !Array.isArray(data.jobs) || data.jobs.length !== data.total_count) fail('invalid_workflow_jobs');
  let seen = false;
  let admittedAt = null;
  for (const job of data.jobs) {
    if (!isObject(job) || !isId(job.id) || job.run_id !== run.id || !Array.isArray(job.steps) || job.steps.length > 100) fail('invalid_workflow_jobs');
    for (const step of job.steps) {
      if (!isObject(step) || typeof step.name !== 'string' || !Number.isSafeInteger(step.number)) fail('invalid_workflow_jobs');
      if (step.name !== COLLECTION_STEP) continue;
      if (seen) fail('invalid_workflow_jobs');
      seen = true;
      if (step.conclusion === 'skipped') continue;
      if (step.status !== 'completed' || !CONCLUSIONS.has(step.conclusion)) fail('invalid_workflow_jobs');
      const started = timestamp(step.started_at, now);
      if (started < timestamp(run.created_at, now)) fail('invalid_github_timestamp');
      admittedAt = started;
    }
  }
  // Older deployments might not have the named step. Honor their successful
  // run once, conservatively, until the new workflow history is available.
  if (!seen && run.conclusion === 'success') return run.activityTime;
  return admittedAt;
}

export async function checkCollection(env, { fetchImpl = fetch, now = Date.now(), log = entry => console.log(JSON.stringify(entry)) } = {}) {
  const record = (reason, details = {}) => {
    const result = { scheduler: 'pharma-collection', reason, ...details };
    log(result);
    return result;
  };
  try {
    if (!Number.isFinite(now)) fail('invalid_clock');
    const config = configuration(env);
    if (!config.enabled) return record('disabled');
    const workflow = await github(fetchImpl, config.token, workflowPath);
    if (!isObject(workflow) || !isId(workflow.id) || workflow.path !== `.github/workflows/${WORKFLOW}` || typeof workflow.state !== 'string') fail('invalid_workflow_metadata');
    if (workflow.state !== 'active') return record('workflow_disabled');
    const variable = await github(fetchImpl, config.token, `${repositoryPath}/actions/variables/COLLECT_ENABLED`);
    if (!isObject(variable) || variable.name !== 'COLLECT_ENABLED' || !['true', 'false'].includes(variable.value)) fail('invalid_collection_flag');
    if (variable.value !== 'true') return record('collection_disabled');

    // Filtered queries find even an old queued run outside the recent page.
    // Read/dispatch is not atomic; workflow concurrency and the database gate
    // enforce admission if a GitHub schedule starts during this check.
    const activeLists = await Promise.all(ACTIVE_STATUSES.map(async status => {
      const data = await github(fetchImpl, config.token, `${workflowPath}/runs?branch=${REF}&status=${status}&per_page=1`);
      const runs = validateRunList(data, workflow.id, now, 1);
      if (runs.some(run => run.status !== status)) fail('invalid_workflow_runs');
      return runs;
    }));
    const active = activeLists.flat().sort((a, b) => a.activityTime - b.activityTime)[0];
    if (active) {
      if (now - active.activityTime >= STALE_ACTIVE_MS) fail('stale_active_run');
      return record('active_run', { runId: active.id });
    }
    const recentData = await github(fetchImpl, config.token, `${workflowPath}/runs?branch=${REF}&per_page=${RECENT_RUN_LIMIT}`);
    const runs = validateRunList(recentData, workflow.id, now, RECENT_RUN_LIMIT);
    for (const run of runs) {
      if (run.status !== 'completed') return record('active_run', { runId: run.id });
      if (run.conclusion === 'action_required') fail('workflow_action_required');
      if (run.conclusion === 'skipped' || now - run.activityTime >= LOOKBACK_MS) continue;
      const jobs = await github(fetchImpl, config.token, `${repositoryPath}/actions/runs/${run.id}/jobs?filter=latest&per_page=10`);
      const admittedAt = admittedStepTime(jobs, run, now);
      if (admittedAt !== null && now - admittedAt < MIN_INTERVAL_MS) return record('recent_collection', { runId: run.id });
    }
    if (config.dryRun) return record('dry_run_due');
    const result = await github(fetchImpl, config.token, `${workflowPath}/dispatches`, { method: 'POST', body: { ref: REF, inputs: { trigger_source: 'cloudflare' } } });
    return record('dispatched', result.dispatchId === null ? {} : { runId: result.dispatchId });
  } catch (error) {
    const reason = error instanceof SchedulerError ? error.reason : 'scheduler_internal_error';
    record(reason);
    // No response bodies, injected values, nested causes or original errors.
    throw new SchedulerError(reason);
  }
}

export default {
  async scheduled(_controller, env, context) {
    context.waitUntil(checkCollection(env));
  },
  async fetch() {
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  },
};
