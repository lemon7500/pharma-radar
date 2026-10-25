// This deliberately runs the production module in workerd instead of Node's
// Fetch implementation. Miniflare is a pinned CI-only tool, never an app dependency.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
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
    if (request.headers.get('accept-encoding') !== 'identity') return reject('accept-encoding');
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

// Embedded only in the local contract runtime below; the deployed HTTP handler
// is untouched. Every scheduler fetch is an in-runtime fixture and the outbound
// service rejects any accidental external request.
async function diagnosticContract({ now, enabled, mode = 'normal' }) {
  const base = '/repos/lemon7500/pharma-radar';
  const workflow = `${base}/actions/workflows/pharma-collect.yml`;
  const token = 'fake_diagnostic_workerd_contract_000000000';
  const logs = [];
  const calls = [];
  let encodingReads = 0;
  let lengthReads = 0;
  let lateEncodingReads = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const originalSlice = Array.prototype.slice;
  const bytes = new TextEncoder().encode(JSON.stringify({ id: 7, path: '.github/workflows/pharma-collect.yml', state: 'active', privateValue: 'body_private_sentinel' }));
  const instrument = (response, category) => {
    const headers = response.headers;
    Object.defineProperty(response, 'headers', { value: { get(name) {
      if (name === 'content-length') {
        lengthReads++;
        if (category === 'dispatch' && mode === '204-length-failure') throw new Error('private_length_sentinel');
      }
      if (name === 'content-encoding') {
        encodingReads++;
        if (category === 'active' && mode === 'late-active-failure') lateEncodingReads++;
        if (category === 'metadata' && mode === 'encoding-failure') throw new Error('private_encoding_sentinel');
        if (category === 'dispatch' && mode === 'snapshot-failure') Array.prototype.slice = () => { throw new Error('private_snapshot_sentinel'); };
      }
      return headers.get(name);
    } } });
    return response;
  };
  const fetchImpl = async (address, options) => {
    const url = new URL(address);
    calls.push({ origin: url.origin, path: url.pathname, method: options.method, redirect: options.redirect });
    if (url.origin !== 'https://api.github.com' || options.redirect !== 'manual' || options.headers.Authorization !== `Bearer ${token}` || options.headers['Accept-Encoding'] !== 'identity') throw new Error('Unexpected closed fixture request');
    if (url.pathname === workflow && options.method === 'GET') {
      if (mode === 'bad-json') return instrument(new Response('{body_private_sentinel'), 'metadata');
      const chunks = [bytes.slice(0, 20), bytes.slice(20)];
      let index = 0;
      return instrument(new Response(new ReadableStream({ pull(controller) {
        if (index < chunks.length) controller.enqueue(chunks[index++]);
        else controller.close();
      } }, { highWaterMark: 0 }), { headers: { 'Content-Length': '0', 'Content-Encoding': 'gzip' } }), 'metadata');
    }
    if (url.pathname === `${base}/actions/variables/COLLECT_ENABLED`) return instrument(Response.json({ name: 'COLLECT_ENABLED', value: 'true' }), 'flag');
    if (url.pathname === `${workflow}/runs`) {
      const status = url.searchParams.get('status');
      if (status && mode === 'late-active-failure') {
        if (status === 'queued') return new Response(null, { status: 401 });
        await gate;
      }
      return instrument(Response.json({ total_count: 0, workflow_runs: [] }), status ? 'active' : 'history');
    }
    if (url.pathname === `${workflow}/dispatches` && options.method === 'POST') {
      if (mode === 'unknown-post') throw new Error('private_post_sentinel');
      return instrument(new Response(null, { status: 204 }), 'dispatch');
    }
    throw new Error('Unexpected closed fixture request');
  };
  let result;
  let failure;
  try {
    result = await checkCollection({ ENABLE: 'true', DRY_RUN: 'false', GITHUB_TOKEN: token, DIAGNOSTICS_ENABLED: enabled }, { fetchImpl, now, log: entry => logs.push(entry) });
  } catch (error) {
    failure = { name: error.name, reason: error.reason, message: error.message };
  } finally {
    Array.prototype.slice = originalSlice;
  }
  const loggedBeforeLate = JSON.stringify(logs);
  release();
  await new Promise(resolve => setTimeout(resolve, 0));
  return { result, failure, logs, calls, encodingReads, lengthReads, lateEncodingReads, lateLogUnchanged: loggedBeforeLate === JSON.stringify(logs), metadataBytes: bytes.length };
}

test('workerd: bounded diagnostics preserve decisions, failures and exact-window behavior', async t => {
  const source = await readFile(productionModule, 'utf8');
  assert.equal(source.split('export default {').length, 2);
  const script = source.replace('export default {', 'const productionHandler = {')
    + `\n${diagnosticContract.toString()}\nexport default { async fetch(request) { return Response.json(await diagnosticContract(await request.json())); } };\n`;
  let externalRequests = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'scheduler-diagnostics-closed-contract', script, modules: true,
    compatibilityDate: '2026-10-09', cf: false, log: new Log(LogLevel.NONE), telemetry: { enabled: false },
    outboundService: async () => { externalRequests++; throw new Error('External requests forbidden in diagnostic contract'); },
  }));
  t.after(async () => { assert.equal(externalRequests, 0); await mf.dispose(); });
  await mf.ready;
  const start = Date.parse('2026-10-25T08:00:00Z');
  const end = Date.parse('2026-10-25T20:00:00Z');
  const probe = async input => {
    const response = await mf.dispatchFetch('http://localhost/closed-contract', { method: 'POST', body: JSON.stringify(input) });
    assert.equal(response.status, 200);
    return response.json();
  };
  for (const [label, now, enabled, present] of [
    ['before window', start - 1, 'true', false], ['start included', start, 'true', true],
    ['end minus one', end - 1, 'true', true], ['end excluded', end, 'true', false],
    ['missing switch', start, undefined, false], ['false switch', start, 'false', false],
    ['invalid switch', start, 'TRUE', false],
  ]) await t.test(label, async () => {
    const data = await probe({ now, enabled });
    assert.deepEqual(data.result, { scheduler: 'pharma-collection', reason: 'dispatched' });
    assert.equal(data.calls.length, 9);
    assert.equal(data.calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(data.logs.length, 1);
    assert.equal(!!data.logs[0].stats, present);
    assert.equal(data.encodingReads, present ? 9 : 0);
    assert.equal(data.lengthReads, present ? 9 : 8, 'Only enabled diagnostics may inspect a 204 length header');
    if (present) {
      const stats = data.logs[0].stats;
      assert.equal(stats.complete, true);
      assert.deepEqual(stats.metadata, { n: 1, b: data.metadataBytes, c: 2, e: [0, 0, 1, 0, 0, 0, 0], h: [1, 0, 0] });
      assert.equal(stats.active.n, 5);
      assert.deepEqual(stats.dispatch, { n: 1, b: 0, c: 0, e: [1, 0, 0, 0, 0, 0, 0], h: [0, 1, 0] });
    }
  });
  for (const mode of ['encoding-failure', '204-length-failure', 'snapshot-failure']) await t.test(mode, async () => {
    const data = await probe({ now: start, enabled: 'true', mode });
    assert.deepEqual(data.result, { scheduler: 'pharma-collection', reason: 'dispatched' });
    assert.deepEqual(data.logs, [data.result]);
    assert.equal(data.calls.filter(call => call.method === 'POST').length, 1);
    if (mode === 'encoding-failure') assert.equal(data.encodingReads, 1, 'Invalid collectors stop reading diagnostic headers');
  });
  for (const [mode, reason, posts] of [
    ['late-active-failure', 'github_authentication_failed', 0],
    ['bad-json', 'invalid_github_json', 0],
    ['unknown-post', 'github_network_error', 1],
  ]) await t.test(mode, async () => {
    const data = await probe({ now: start, enabled: 'true', mode });
    assert.equal(data.failure.reason, reason);
    assert.equal(data.logs.length, 1);
    assert.equal(data.logs[0].reason, reason);
    assert.equal(data.logs[0].stats.complete, false);
    assert.equal(data.logs[0].stats.dispatch.n, 0);
    assert.equal(data.calls.filter(call => call.method === 'POST').length, posts);
    assert.equal(data.lateLogUnchanged, true);
    assert.equal(data.lateEncodingReads, 0);
    const logged = JSON.stringify({ logs: data.logs, failure: data.failure });
    assert.equal(logged.includes('private_'), false);
    assert.equal(logged.includes('fake_diagnostic'), false);
  });
});
