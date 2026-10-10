import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { checkCollection } from './worker.mjs';

const NOW = Date.parse('2026-10-09T08:00:00Z');
const TOKEN = 'test_only_mock_token_not_a_real_credential';
const REPOSITORY = 'lemon7500/pharma-radar';
const BASE = `/repos/${REPOSITORY}`;
const WORKFLOW = `${BASE}/actions/workflows/pharma-collect.yml`;
const STEP = 'Process due sources and queued work';
const ACTIVE = ['queued', 'in_progress', 'waiting', 'requested', 'pending'];
const ENV = { ENABLE: 'true', DRY_RUN: 'false', GITHUB_TOKEN: TOKEN };

function iso(minutesAgo) {
  return new Date(NOW - minutesAgo * 60_000).toISOString();
}

function run({ id = 21, status = 'completed', conclusion = 'success', age = 15, ...overrides } = {}) {
  return {
    id,
    workflow_id: 7,
    head_branch: 'main',
    repository: { full_name: REPOSITORY },
    status,
    conclusion: status === 'completed' ? conclusion : null,
    created_at: iso(age),
    run_started_at: iso(age),
    ...overrides,
  };
}

function list(runs) {
  return { total_count: runs.length, workflow_runs: runs };
}

function jobs(runId, { name = STEP, status = 'completed', conclusion = 'success', age = 10, ...overrides } = {}) {
  return {
    total_count: 1,
    jobs: [{ id: 31, run_id: runId, steps: [{ name, number: 4, status, conclusion, started_at: iso(age), ...overrides }] }],
  };
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

// Every request is answered locally. Unexpected targets throw before any I/O.
function harness({ active = {}, recent = [], jobData = new Map(), override, dispatch = () => new Response(null, { status: 204 }), flag = 'true', state = 'active' } = {}) {
  const requests = [];
  const logs = [];
  const fetchImpl = async (urlValue, options) => {
    const url = new URL(urlValue);
    const request = { url, options };
    requests.push(request);
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(options.headers['X-GitHub-Api-Version'], '2022-11-28');
    assert.ok(options.signal instanceof AbortSignal);
    if (override) {
      const replacement = await override(request);
      if (replacement !== undefined) return replacement;
    }
    if (url.pathname === WORKFLOW && options.method === 'GET') {
      return json({ id: 7, path: '.github/workflows/pharma-collect.yml', state });
    }
    if (url.pathname === `${BASE}/actions/variables/COLLECT_ENABLED`) return json({ name: 'COLLECT_ENABLED', value: flag });
    if (url.pathname === `${WORKFLOW}/runs`) {
      assert.equal(url.searchParams.get('branch'), 'main');
      const status = url.searchParams.get('status');
      assert.equal(url.searchParams.get('per_page'), status === null ? '10' : '1');
      if (status !== null) {
        assert.equal(url.searchParams.has('created'), false, 'Active queries must see old queued work');
        assert.ok(ACTIVE.includes(status));
        return json(list(active[status] ?? []));
      }
      assert.equal(url.searchParams.get('created'), `>=${iso(210)}`);
      return json(list(recent));
    }
    const jobMatch = url.pathname.match(/^\/repos\/lemon7500\/pharma-radar\/actions\/runs\/(\d+)\/jobs$/);
    if (jobMatch) {
      assert.equal(url.searchParams.get('filter'), 'latest');
      assert.equal(url.searchParams.get('per_page'), '10');
      const data = jobData.get(Number(jobMatch[1]));
      assert.notEqual(data, undefined, 'Unexpected jobs request');
      return json(data);
    }
    if (url.pathname === `${WORKFLOW}/dispatches` && options.method === 'POST') return dispatch(request);
    assert.fail(`Unexpected mock request: ${url.pathname}`);
  };
  const check = (env = ENV) => checkCollection(env, { fetchImpl, now: NOW, log: entry => logs.push(entry) });
  const dispatches = () => requests.filter(({ options }) => options.method === 'POST');
  return { requests, logs, check, dispatches };
}

async function rejectsWith(h, reason, env = ENV) {
  await assert.rejects(h.check(env), error => {
    assert.equal(error.name, 'SchedulerError');
    assert.equal(error.reason, reason);
    assert.equal(error.message, `Collection scheduler failed: ${reason}`);
    assert.ok(!error.message.includes(TOKEN));
    return true;
  });
  assert.deepEqual(h.logs, [{ scheduler: 'pharma-collection', reason }]);
}

test('scheduler is disabled by default and needs no token', async () => {
  const h = harness();
  assert.equal((await h.check({})).reason, 'disabled');
  assert.equal(h.requests.length, 0);
});

test('explicit disable performs no requests', async () => {
  const h = harness();
  assert.equal((await h.check({ ENABLE: 'false' })).reason, 'disabled');
  assert.equal(h.requests.length, 0);
});

test('enabled scheduler defaults to dry run', async () => {
  const h = harness();
  assert.equal((await h.check({ ENABLE: 'true', GITHUB_TOKEN: TOKEN })).reason, 'dry_run_due');
  assert.equal(h.dispatches().length, 0);
  assert.equal(h.requests.length, 8);
});

test('explicit dry run checks state and sends no dispatch', async () => {
  const h = harness();
  assert.equal((await h.check({ ...ENV, DRY_RUN: 'true' })).reason, 'dry_run_due');
  assert.equal(h.dispatches().length, 0);
});

test('disabled workflow or collection variable suppresses dispatch', async t => {
  for (const [options, reason, count] of [[{ state: 'disabled_manually' }, 'workflow_disabled', 1], [{ flag: 'false' }, 'collection_disabled', 2]]) {
    await t.test(reason, async () => {
      const h = harness(options);
      assert.equal((await h.check()).reason, reason);
      assert.equal(h.requests.length, count);
      assert.equal(h.dispatches().length, 0);
    });
  }
});

test('dispatch accepts HTTP 204 and supplies the Cloudflare workflow input', async () => {
  const h = harness();
  assert.deepEqual(await h.check(), { scheduler: 'pharma-collection', reason: 'dispatched' });
  assert.equal(h.dispatches().length, 1);
  const { url, options } = h.dispatches()[0];
  assert.equal(url.pathname, `${WORKFLOW}/dispatches`);
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(options.body), { ref: 'main', inputs: { trigger_source: 'cloudflare' } });
});

test('dispatch accepts HTTP 200 with a validated workflow_run_id', async () => {
  const h = harness({ dispatch: () => json({ workflow_run_id: 543 }) });
  assert.deepEqual(await h.check(), { scheduler: 'pharma-collection', reason: 'dispatched', runId: 543 });
  assert.equal(h.dispatches().length, 1);
});

for (const status of ACTIVE) {
  test(`current ${status} run suppresses dispatch`, async () => {
    const h = harness({ active: { [status]: [run({ status })] } });
    assert.deepEqual(await h.check(), { scheduler: 'pharma-collection', reason: 'active_run', runId: 21 });
    assert.equal(h.dispatches().length, 0);
    assert.deepEqual(h.requests.filter(({ url }) => url.searchParams.has('status')).map(({ url }) => url.searchParams.get('status')).sort(), [...ACTIVE].sort());
    assert.equal(h.requests.length, 7);
  });
}

test('stale active run fails closed without adding queued work', async () => {
  const h = harness({ active: { queued: [run({ status: 'queued', age: 120 })] } });
  await rejectsWith(h, 'stale_active_run');
  assert.equal(h.dispatches().length, 0);
  assert.equal(h.requests.length, 7);
});

test('historical response uses a creation window without filtering active queries', async () => {
  const h = harness();
  assert.equal((await h.check()).reason, 'dispatched');
  const recent = h.requests.find(({ url }) => url.pathname.endsWith('/runs') && !url.searchParams.has('status'));
  assert.equal(recent.url.searchParams.get('created'), `>=${iso(210)}`);
  assert.equal(h.requests.filter(({ url }) => url.searchParams.has('status')).length, 5);
});

test('old queued work remains visible outside the historical creation window', async () => {
  const h = harness({ active: { queued: [run({ status: 'queued', age: 240 })] } });
  await rejectsWith(h, 'stale_active_run');
  assert.equal(h.requests.length, 7);
  assert.equal(h.dispatches().length, 0);
});

test('a delayed start inside the creation window uses actual collection time', async () => {
  const h = harness({
    recent: [run({ age: 200, run_started_at: iso(20) })],
    jobData: new Map([[21, jobs(21, { age: 10 })]]),
  });
  assert.equal((await h.check()).reason, 'recent_collection');
  assert.equal(h.dispatches().length, 0);
});

test('a stalled GitHub request is aborted at its deadline without logging its original error', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness({ override: ({ options }) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error(`private transport error ${TOKEN}`)), { once: true });
  }) });
  const pending = rejectsWith(h, 'github_timeout');
  t.mock.timers.tick(8_000);
  await pending;
  assert.equal(h.dispatches().length, 0);
  assert.equal(JSON.stringify(h.logs).includes(TOKEN), false);
});

test('active run appearing in recent results suppresses dispatch', async () => {
  const h = harness({ recent: [run({ status: 'in_progress' })] });
  assert.equal((await h.check()).reason, 'active_run');
  assert.equal(h.dispatches().length, 0);
});

test('actual collection step suppresses dispatch even when the run failed', async () => {
  const h = harness({ recent: [run({ conclusion: 'failure' })], jobData: new Map([[21, jobs(21, { conclusion: 'failure', age: 10 })]]) });
  assert.deepEqual(await h.check(), { scheduler: 'pharma-collection', reason: 'recent_collection', runId: 21 });
  assert.equal(h.dispatches().length, 0);
});

test('collection interval uses step start and admits at exactly 55 minutes', async t => {
  for (const [age, reason] of [[54, 'recent_collection'], [55, 'dispatched']]) {
    await t.test(`${age} minutes`, async () => {
      const h = harness({ recent: [run({ age: 60 })], jobData: new Map([[21, jobs(21, { age })]]) });
      assert.equal((await h.check()).reason, reason);
    });
  }
});

test('skipped collection step does not suppress a new dispatch', async () => {
  const h = harness({ recent: [run()], jobData: new Map([[21, jobs(21, { conclusion: 'skipped', started_at: null })]]) });
  assert.equal((await h.check()).reason, 'dispatched');
  assert.equal(h.dispatches().length, 1);
});

test('legacy successful run falls back to run time when the step is absent', async t => {
  for (const [age, reason] of [[15, 'recent_collection'], [60, 'dispatched']]) {
    await t.test(`${age} minutes`, async () => {
      const h = harness({ recent: [run({ age })], jobData: new Map([[21, jobs(21, { name: 'Legacy collection', age })]]) });
      assert.equal((await h.check()).reason, reason);
    });
  }
});

test('unsuccessful run with no collection step does not suppress dispatch', async () => {
  const h = harness({ recent: [run({ conclusion: 'failure' })], jobData: new Map([[21, jobs(21, { name: 'Set up job' })]]) });
  assert.equal((await h.check()).reason, 'dispatched');
});

test('cancelled and failed runs may legitimately contain zero jobs', async t => {
  for (const conclusion of ['cancelled', 'failure', 'neutral', 'timed_out', 'stale']) {
    await t.test(conclusion, async () => {
      const h = harness({ recent: [run({ conclusion })], jobData: new Map([[21, { total_count: 0, jobs: [] }]]) });
      assert.equal((await h.check()).reason, 'dispatched');
      assert.equal(h.dispatches().length, 1);
    });
  }
});

test('successful run with zero jobs remains fail closed', async () => {
  const h = harness({ recent: [run()], jobData: new Map([[21, { total_count: 0, jobs: [] }]]) });
  await rejectsWith(h, 'invalid_workflow_jobs');
  assert.equal(h.dispatches().length, 0);
});

test('zero jobs exception requires the exact valid empty list shape', async t => {
  for (const data of [{ total_count: 0, jobs: [{}] }, { total_count: 0, jobs: null }, { total_count: null, jobs: [] }]) {
    await t.test(JSON.stringify(data), async () => {
      const h = harness({ recent: [run({ conclusion: 'cancelled' })], jobData: new Map([[21, data]]) });
      await rejectsWith(h, 'invalid_workflow_jobs');
      assert.equal(h.dispatches().length, 0);
    });
  }
});

test('skipped and old completed runs do not request jobs', async () => {
  const h = harness({ recent: [run({ id: 21, conclusion: 'skipped' }), run({ id: 22, age: 90 })] });
  assert.equal((await h.check()).reason, 'dispatched');
  assert.equal(h.requests.some(({ url }) => url.pathname.endsWith('/jobs')), false);
});

test('action required fails closed without dispatch', async () => {
  const h = harness({ recent: [run({ conclusion: 'action_required' })] });
  await rejectsWith(h, 'workflow_action_required');
  assert.equal(h.dispatches().length, 0);
});

test('authentication, permission, rate limit and missing resources fail closed', async t => {
  for (const [status, headers, reason] of [
    [401, {}, 'github_authentication_failed'],
    [403, {}, 'github_permission_denied'],
    [403, { 'x-ratelimit-remaining': '0' }, 'github_rate_limited'],
    [429, {}, 'github_rate_limited'],
    [404, {}, 'github_resource_unavailable'],
  ]) {
    await t.test(`${status} ${reason}`, async () => {
      const h = harness({ override: () => json({ message: TOKEN }, status, headers) });
      await rejectsWith(h, reason);
      assert.equal(h.requests.length, 1);
      assert.equal(h.dispatches().length, 0);
    });
  }
});

test('redirects are rejected without following another origin', async t => {
  for (const status of [300, 301, 302, 303, 304, 307, 308, 399]) {
    await t.test(String(status), async () => {
      const h = harness({ override: () => new Response(null, { status, headers: { Location: 'https://attacker.invalid/steal' } }) });
      await rejectsWith(h, 'github_request_rejected');
      assert.equal(h.requests.length, 1);
      assert.equal(h.dispatches().length, 0);
    });
  }
  await t.test('fetch rejects redirect', async () => {
    const h = harness({ override: () => { throw new TypeError(`redirect contains ${TOKEN}`); } });
    await rejectsWith(h, 'github_network_error');
    assert.equal(h.requests.length, 1);
  });
});

test('dispatch rejects every redirect family without following or replaying', async t => {
  for (const status of [300, 301, 302, 303, 304, 307, 308, 399]) {
    await t.test(String(status), async () => {
      const h = harness({ dispatch: () => new Response(null, { status, headers: { Location: 'https://attacker.invalid/steal' } }) });
      await rejectsWith(h, 'github_dispatch_rejected');
      assert.equal(h.dispatches().length, 1);
      assert.equal(h.requests.length, 9);
    });
  }
});

test('uncertain dispatch results are never replayed and do not leak errors', async t => {
  for (const [name, dispatch, reason] of [
    ['network error', () => { throw new Error(`private: ${TOKEN}`); }, 'github_network_error'],
    ['server error', () => json({ message: TOKEN }, 500), 'github_dispatch_rejected'],
    ['redirect', () => new Response(null, { status: 307, headers: { Location: 'https://attacker.invalid' } }), 'github_dispatch_rejected'],
    ['invalid JSON', () => new Response(`{"secret":"${TOKEN}"`, { status: 200 }), 'invalid_github_json'],
    ['missing run id', () => json({ secret: TOKEN }), 'invalid_dispatch_response'],
    ['string run id', () => json({ workflow_run_id: '543' }), 'invalid_dispatch_response'],
    ['unsafe run id', () => json({ workflow_run_id: Number.MAX_SAFE_INTEGER + 1 }), 'invalid_dispatch_response'],
  ]) {
    await t.test(name, async () => {
      const h = harness({ dispatch });
      await rejectsWith(h, reason);
      assert.equal(h.dispatches().length, 1);
      assert.equal(h.requests.length, 9);
    });
  }
});

test('malformed JSON and invalid UTF-8 fail closed without body logging', async t => {
  for (const [name, body] of [['malformed', `{"token":"${TOKEN}"`], ['invalid UTF-8', new Uint8Array([0xc3, 0x28])]]) {
    await t.test(name, async () => {
      const h = harness({ override: () => new Response(body, { status: 200 }) });
      await rejectsWith(h, 'invalid_github_json');
      assert.equal(h.dispatches().length, 0);
    });
  }
});

test('response byte limit is 128 KiB for declared and streaming lengths', async t => {
  await t.test('declared oversized length rejects before reading', async () => {
    const h = harness({ override: () => json({}, 200, { 'Content-Length': String(128 * 1024 + 1) }) });
    await rejectsWith(h, 'github_response_too_large');
    assert.equal(h.dispatches().length, 0);
  });
  await t.test('streamed oversized body rejects without content length', async () => {
    const h = harness({ override: () => new Response(' '.repeat(128 * 1024 + 1), { status: 200 }) });
    await rejectsWith(h, 'github_response_too_large');
    assert.equal(h.dispatches().length, 0);
  });
  await t.test('exact byte limit remains accepted', async () => {
    const body = JSON.stringify({ id: 7, path: '.github/workflows/pharma-collect.yml', state: 'active' });
    const h = harness({ override: ({ url }) => url.pathname === WORKFLOW ? new Response(body.padEnd(128 * 1024), { status: 200 }) : undefined });
    assert.equal((await h.check()).reason, 'dispatched');
  });
  await t.test('invalid declared length fails closed', async () => {
    const h = harness({ override: () => json({}, 200, { 'Content-Length': '-1' }) });
    await rejectsWith(h, 'github_response_too_large');
  });
});

test('future timestamps cannot force collection timing decisions', async t => {
  for (const [name, runOverrides, stepOverrides] of [
    ['future run creation', { created_at: iso(-6), run_started_at: iso(-6) }, null],
    ['future run start', { run_started_at: iso(-6) }, null],
    ['future collection start', {}, { started_at: iso(-6) }],
    ['collection before run creation', {}, { started_at: iso(16) }],
    ['run start before creation', { run_started_at: iso(16) }, null],
  ]) {
    await t.test(name, async () => {
      const h = harness({ recent: [run(runOverrides)], jobData: new Map([[21, jobs(21, stepOverrides ?? {})]]) });
      await rejectsWith(h, 'invalid_github_timestamp');
      assert.equal(h.dispatches().length, 0);
    });
  }
});

test('bindings cannot inject a ref, repository, workflow or API origin', async t => {
  for (const [key, value] of [
    ['GITHUB_REF', 'main\nrefs/heads/attacker'],
    ['GITHUB_API_URL', 'https://attacker.invalid'],
    ['GITHUB_REPOSITORY', 'attacker/repo'],
    ['GITHUB_OWNER', 'attacker'],
    ['GITHUB_REPO', 'attacker'],
    ['WORKFLOW_FILE', '../steal.yml'],
  ]) {
    await t.test(key, async () => {
      const h = harness();
      await rejectsWith(h, 'invalid_configuration', { ...ENV, [key]: value });
      assert.equal(h.requests.length, 0);
      assert.equal(JSON.stringify(h.logs).includes(value), false);
    });
  }
});

test('invalid configuration and fake-token shapes fail without network access', async t => {
  for (const env of [
    { ...ENV, ENABLE: 'TRUE' },
    { ...ENV, DRY_RUN: '1' },
    { ...ENV, GITHUB_TOKEN: undefined },
    { ...ENV, GITHUB_TOKEN: 'short' },
    { ...ENV, GITHUB_TOKEN: `${TOKEN}\n` },
    { ...ENV, GITHUB_TOKEN: 'x'.repeat(257) },
  ]) {
    await t.test(`invalid ${Object.keys(env).find(key => env[key] !== ENV[key])}`, async () => {
      const h = harness();
      await rejectsWith(h, ['TRUE', '1'].includes(env.ENABLE) || env.DRY_RUN === '1' ? 'invalid_configuration' : 'missing_or_invalid_token', env);
      assert.equal(h.requests.length, 0);
    });
  }
});

test('invalid GitHub response shapes fail closed', async t => {
  for (const [name, override, reason] of [
    ['workflow id', ({ url }) => url.pathname === WORKFLOW ? json({ id: '7', path: '.github/workflows/pharma-collect.yml', state: 'active' }) : undefined, 'invalid_workflow_metadata'],
    ['collection flag', ({ url }) => url.pathname.endsWith('/COLLECT_ENABLED') ? json({ name: 'COLLECT_ENABLED', value: 'TRUE' }) : undefined, 'invalid_collection_flag'],
    ['run list count', ({ url }) => url.pathname.endsWith('/runs') ? json({ total_count: 1, workflow_runs: [] }) : undefined, 'invalid_workflow_runs'],
    ['injected run ref', ({ url }) => url.pathname.endsWith('/runs') ? json(list([run({ head_branch: 'attacker' })])) : undefined, 'invalid_workflow_runs'],
  ]) {
    await t.test(name, async () => {
      const h = harness({ override });
      await rejectsWith(h, reason);
      assert.equal(h.dispatches().length, 0);
    });
  }
});

test('successful dispatch logging never contains the token', async () => {
  const h = harness({ dispatch: () => json({ workflow_run_id: 543, secret: TOKEN }) });
  await h.check();
  assert.deepEqual(h.logs, [{ scheduler: 'pharma-collection', reason: 'dispatched', runId: 543 }]);
  assert.equal(JSON.stringify(h.logs).includes(TOKEN), false);
});

test('HTTP entry point always returns 404 with no cacheable trigger', async () => {
  const response = await worker.fetch(new Request('https://scheduler.invalid/?dispatch=true'), ENV);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(await response.text(), 'Not found');
});
