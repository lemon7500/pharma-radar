# Independent collection trigger

GitHub's hourly `schedule` is retained. The optional Cloudflare Worker checks the collection workflow at minutes 7, 27 and 47 of each hour (UTC) and requests a normal `workflow_dispatch` only when collection is enabled and no run is pending. This does not change source fetch intervals, selection rules, model budgets or the historical backfill limit.

## Admission and safe failure

Both native and external triggers use the `Admit collection batch` step. A unique `settings` row (`ops.batch-admission`) atomically admits one run per 55-minute window using the database clock. Denied attempts do not update it, start processing, or change worker heartbeats. The next step is explicitly skipped. Admissions are audited as `batch.admission` with `ok` or `skipped` status.

Failed or cancelled admitted runs retain the fixed window and become eligible automatically after it expires. There is no force/override input. The workflow's existing concurrency group is still required: the database window is a rate gate, not a lifetime lock. The current 20-minute batch and 30-minute workflow deadline are shorter than the window. A 55-minute tolerance can admit about 26 batches in 24 hours; paid requests still use the existing atomic daily/hourly budget controls.

Cloudflare's read/check/dispatch is not atomic. It may race with GitHub or another Cron event; queued duplicate workflows are harmless to actual processing because of the concurrency group and database gate. Active runs are never ignored merely because they are old. A two-hour active run produces a visible error requiring operator investigation.

The recent-run check inspects the named `Process due sources and queued work` step. A skipped step does not count as a recent collection. For older successful workflow versions without that name, it conservatively uses the run start time until that record leaves the lookback window.

All requests use a fixed repository, workflow, ref and `api.github.com` origin, refuse redirects and have bounded response sizes/timeouts. Uncertain dispatch outcomes are not retried in the same invocation. Failures expose a static reason, never response bodies, tokens or original error messages. No HTTP request can dispatch a workflow; `workers.dev` and preview URLs are disabled.

Requests use `redirect: 'manual'`: the Workers runtime rejects the `error` mode supported by Node/browser fetch. Every non-success status, including all 3xx responses from reads or dispatches, is rejected without following `Location` or forwarding credentials. Validate this in actual workerd as well as Node mocks; a Node-only pass does not prove edge-runtime compatibility.

## Account and credential

Use Workers Free. The trigger needs no custom domain, database, KV, R2 or paid plan. The [official pricing](https://developers.cloudflare.com/workers/platform/pricing/) includes 100,000 requests/day and 10 ms CPU/invocation. The [registration page](https://workers.cloudflare.com/) states no credit card is required. About 2,160 checks/month are planned, with a few small GitHub API calls each. Validate real CPU and Cron outcomes after deployment; free plans and schedulers do not provide exact execution guarantees.

Create a fine-grained GitHub PAT owned by `lemon7500`, selecting **only `pharma-radar`**:

- Actions: Read and write.
- Variables: Read-only (needed to check `COLLECT_ENABLED`).
- Metadata: default read access; no additional permissions.

Actions permission also covers other workflows and logs in the selected repository; it is not scoped to one workflow. Use an expiry, rotate it before expiry, and revoke it if unused. Store it only in the ignored local `.env.scheduler` while provisioning and Cloudflare's `GITHUB_TOKEN` Secret. Do not copy the desktop Git credential, database URL, model key, Supabase credentials or admin password into Cloudflare.

## Deployment

The committed configuration defaults to **disabled and dry-run**. Account authorization is a necessary human step. The operator then:

1. Runs `node --test deploy/scheduler/worker.test.mjs`, the admission database tests and type checks. Also runs `node --test deploy/scheduler/runtime.workerd.mjs` with `MINIFLARE_PACKAGE_PATH` set to the absolute directory of Miniflare `5.20261006.1-alpha`. This executes the production module in workerd, with every outgoing request intercepted by a local mock. GitHub CI installs that pinned tool under `RUNNER_TEMP`, outside application dependencies, and runs both scheduler suites as well as normal checks.
2. Publishes the workflow admission step before enabling Cloudflare.
3. Uses the official Wrangler CLI with `deploy/scheduler/wrangler.jsonc`; validates via `deploy --dry-run --no-bundle` first.
4. Deploys with the dedicated `GITHUB_TOKEN` Secret and overrides `ENABLE=true`, `DRY_RUN=true`. No request is dispatched in this mode. Verify GitHub permissions and Cron logs.
5. After the deployed workflow and read-only checks pass, changes to `DRY_RUN=false` and verifies an actual Cron-origin workflow, its admission audit and source successful-fetch times. Do not claim success based on a dispatch receipt alone.

Manage Cron exclusively through this Wrangler configuration. [Cron changes can take up to 15 minutes to propagate](https://developers.cloudflare.com/workers/configuration/cron-triggers/), and event history may appear later. Preserve the explicit enable/dry-run overrides on future deployments; the safe committed defaults otherwise disable the supplement.

## Rollback and observation

Set `ENABLE=false` on the Worker or redeploy the safe defaults. To remove its Cron schedule, explicitly deploy an empty `triggers.crons` array. Leave the GitHub native schedule and admission protection in place. No data migration is required, and rollback does not change public article links, RSS, API, MCP or browser bookmarks.

Observe Cron outcomes/CPU, GitHub run origins and gaps, source successful fetches, pending work, model receipts/budgets, upload cleanup and database size. Authentication failure, stale active runs, malformed GitHub responses and uncertain dispatches are recorded as failures; do not queue unlimited retries or increase model budgets to mask scheduler trouble.
