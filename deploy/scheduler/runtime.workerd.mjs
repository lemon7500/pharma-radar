// This deliberately runs the production module in workerd instead of Node's
// Fetch implementation. Miniflare is a pinned CI-only tool, never an app dependency.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const MINIFLARE_VERSION = '5.20261006.1-alpha';
const miniflareDirectory = process.env.MINIFLARE_PACKAGE_PATH;
assert.ok(miniflareDirectory && isAbsolute(miniflareDirectory), 'MINIFLARE_PACKAGE_PATH must be an absolute Miniflare package directory');
const requireTool = createRequire(join(miniflareDirectory, 'package.json'));
assert.equal(requireTool('./package.json').version, MINIFLARE_VERSION, 'Use the pinned Miniflare version');
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = requireTool(miniflareDirectory);

const productionModule = fileURLToPath(new URL('./worker.mjs', import.meta.url));
const apiOrigin = 'https://api.github.com';
const repository = '/repos/lemon7500/pharma-radar';
const workflow = `${repository}/actions/workflows/pharma-collect.yml`;
const activeStatuses = ['queued', 'in_progress', 'waiting', 'requested', 'pending'];
const token = 'fake_workerd_contract_only_0000000000';
const expectedReads = [
  workflow,
  `${repository}/actions/variables/COLLECT_ENABLED`,
  ...activeStatuses.map(status => `${workflow}/runs?branch=main&status=${status}&per_page=1`),
  `${workflow}/runs?branch=main&per_page=10`,
];

async function runtime(t, { enabled = true, dryRun = true, redirectAt, redirectStatus, recentCollection = false } = {}) {
  const calls = [];
  const unexpected = [];
  const recentRunId = 91;
  const startedAt = new Date(Date.now() - 15 * 60_000).toISOString();
  const processedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const recentJobs = `${repository}/actions/runs/${recentRunId}/jobs?filter=latest&per_page=10`;
  // The outbound override intercepts every fetch. Nothing falls through to the
  // network, including a mistakenly followed redirect or an unexpected target.
  const outboundService = async request => {
    const url = new URL(request.url);
    if (url.pathname === `${workflow}/runs`) {
      if (url.searchParams.has('status')) {
        assert.equal(url.searchParams.has('created'), false, 'Active-run checks must find old queued runs too');
      } else {
        const filters = url.searchParams.getAll('created');
        assert.equal(filters.length, 1, 'Recent runs require exactly one created filter');
        assert.match(filters[0], /^>=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        const boundary = Date.parse(filters[0].slice(2));
        assert.ok(Math.abs(boundary - (Date.now() - 210 * 60_000)) <= 30_000, 'Recent created boundary must be now minus 210 minutes');
        // Only normalize the filter after validating its name, syntax and age.
        // Remaining query parameters still have to match the exact mock path.
        url.searchParams.delete('created');
      }
    }
    const path = url.pathname + url.search;
    const call = { method: request.method, origin: url.origin, path };
    calls.push(call);
    const reject = reason => {
      unexpected.push({ ...call, reason });
      throw new Error(`Unexpected mock request: ${reason}`);
    };
    if (url.origin !== apiOrigin) return reject('origin');
    if (request.headers.get('authorization') !== `Bearer ${token}`) return reject('authorization');
    if (recentCollection && request.method === 'GET' && path === recentJobs) {
      return Response.json({ total_count: 1, jobs: [{ id: 31, run_id: recentRunId, steps: [{
        name: 'Process due sources and queued work', number: 4,
        status: 'completed', conclusion: 'success', started_at: processedAt,
      }] }] });
    }
    if (request.method === 'GET' && expectedReads.includes(path)) {
      if (redirectAt === 'GET') return new Response(null, { status: redirectStatus, headers: { Location: 'https://invalid.invalid/must-not-follow' } });
      if (path === workflow) return Response.json({ id: 77, path: '.github/workflows/pharma-collect.yml', state: 'active' });
      if (path === `${repository}/actions/variables/COLLECT_ENABLED`) return Response.json({ name: 'COLLECT_ENABLED', value: 'true' });
      if (recentCollection && path === `${workflow}/runs?branch=main&per_page=10`) {
        return Response.json({ total_count: 1, workflow_runs: [{
          id: recentRunId, workflow_id: 77, head_branch: 'main',
          repository: { full_name: 'lemon7500/pharma-radar' },
          status: 'completed', conclusion: 'success',
          created_at: startedAt, run_started_at: startedAt,
        }] });
      }
      return Response.json({ total_count: 0, workflow_runs: [] });
    }
    if (request.method === 'POST' && path === `${workflow}/dispatches`) {
      assert.deepEqual(await request.json(), { ref: 'main', inputs: { trigger_source: 'cloudflare' } });
      if (redirectAt === 'POST') return new Response(null, { status: redirectStatus, headers: { Location: 'https://invalid.invalid/must-not-follow' } });
      return new Response(null, { status: 204 });
    }
    return reject('method or path');
  };
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'pharma-scheduler-workerd-contract',
    scriptPath: productionModule,
    modules: true,
    compatibilityDate: '2026-10-09',
    unsafeTriggerHandlers: true,
    bindings: { ENABLE: String(enabled), DRY_RUN: String(dryRun), GITHUB_TOKEN: token },
    outboundService,
    cf: false,
    log: new Log(LogLevel.NONE),
    telemetry: { enabled: false },
  }));
  t.after(async () => {
    try { assert.deepEqual(unexpected, [], 'No unmatched fetch may escape the local mock'); }
    finally { await mf.dispose(); }
  });
  await mf.ready;
  return {
    calls,
    fetch: url => mf.dispatchFetch(url),
    scheduled: () => mf.dispatchFetch('http://localhost/cdn-cgi/local/scheduled?cron=7,27,47%20*%20*%20*%20*'),
  };
}

function assertReads(calls) {
  assert.deepEqual(calls.filter(call => call.method === 'GET').map(call => call.path).sort(), [...expectedReads].sort());
}

test('workerd: disabled scheduled handler does not fetch', async t => {
  const probe = await runtime(t, { enabled: false });
  const response = await probe.scheduled();
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ok');
  assert.deepEqual(probe.calls, []);
});

test('workerd: dry run performs eight reads and no dispatch', async t => {
  const probe = await runtime(t);
  const response = await probe.scheduled();
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ok');
  assertReads(probe.calls);
  assert.equal(probe.calls.length, 8);
  assert.equal(probe.calls.filter(call => call.method === 'POST').length, 0);
});

test('workerd: enabled run dispatches exactly once to the local mock', async t => {
  const probe = await runtime(t, { dryRun: false });
  const response = await probe.scheduled();
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ok');
  assertReads(probe.calls);
  assert.equal(probe.calls.length, 9);
  assert.deepEqual(probe.calls.filter(call => call.method === 'POST'), [{ method: 'POST', origin: apiOrigin, path: `${workflow}/dispatches` }]);
});

test('workerd: recent actual collection returns after four reads without active checks or dispatch', async t => {
  const probe = await runtime(t, { dryRun: false, recentCollection: true });
  const response = await probe.scheduled();
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ok');
  assert.deepEqual(probe.calls, [
    { method: 'GET', origin: apiOrigin, path: workflow },
    { method: 'GET', origin: apiOrigin, path: `${repository}/actions/variables/COLLECT_ENABLED` },
    { method: 'GET', origin: apiOrigin, path: `${workflow}/runs?branch=main&per_page=10` },
    { method: 'GET', origin: apiOrigin, path: `${repository}/actions/runs/91/jobs?filter=latest&per_page=10` },
  ]);
  assert.equal(probe.calls.some(call => new URL(call.path, apiOrigin).searchParams.has('status')), false);
  assert.equal(probe.calls.filter(call => call.method === 'POST').length, 0);
});

for (const redirectStatus of [301, 302, 303, 307, 308]) {
  test(`workerd: rejects GET ${redirectStatus} without following or dispatching`, async t => {
    const probe = await runtime(t, { redirectAt: 'GET', redirectStatus });
    const response = await probe.scheduled();
    assert.equal(response.status, 500);
    assert.equal(await response.text(), 'exception');
    assert.deepEqual(probe.calls, [{ method: 'GET', origin: apiOrigin, path: workflow }]);
  });
  test(`workerd: rejects POST ${redirectStatus} without following or retrying`, async t => {
    const probe = await runtime(t, { dryRun: false, redirectAt: 'POST', redirectStatus });
    const response = await probe.scheduled();
    assert.equal(response.status, 500);
    assert.equal(await response.text(), 'exception');
    assertReads(probe.calls);
    assert.equal(probe.calls.length, 9);
    assert.deepEqual(probe.calls.filter(call => call.method === 'POST'), [{ method: 'POST', origin: apiOrigin, path: `${workflow}/dispatches` }]);
  });
}

test('workerd: HTTP requests remain a non-triggering 404', async t => {
  const probe = await runtime(t, { dryRun: false });
  const response = await probe.fetch('http://localhost/');
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), 'Not found');
  assert.deepEqual(probe.calls, []);
});
