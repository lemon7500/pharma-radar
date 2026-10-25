# Temporary response diagnostics

The scheduler's real dispatch events sometimes exceed the Free plan's nominal
10 ms CPU allowance. Request counts alone have not explained the difference.
These diagnostics measure response shape; they do not implement a CPU fix.

## Activation and expiry

Diagnostics require `DIAGNOSTICS_ENABLED=true` and an invocation-start time in
`2026-10-25T08:00:00Z <= now < 2026-10-25T20:00:00Z`. Missing, false, or malformed
values disable diagnostics without changing collection configuration. The end
time is a code-level limit, so leaving the variable enabled cannot extend it.

The cutoff applies to new invocations. An invocation started before the cutoff
can finish its existing requests and emit its final log after it. The existing
maximum of 19 requests and 8-second request/body timeout bounds that tail; this
is not a claim of exactly zero diagnostic instructions after the end time.

There is no additional HTTP trigger, Cron, timer, model request, storage binding,
or background monitoring task. Existing dispatch safety and model budgets remain
unchanged. Deploying this code does not require a database migration.

## Log format and meaning

The existing single scheduler log can include `stats` with `v: 1`, `complete`,
and six fixed categories: `metadata`, `flag`, `history`, `jobs`, `active`, and
`dispatch`. Each category contains:

- `n`: responses successfully read to EOF and parsed, or a successful empty 204.
- `b`: bytes delivered by the response body; 204 contributes zero.
- `c`: non-EOF body chunks already collected by the existing reader.
- `e`: seven counts, ordered as missing Content-Encoding, identity, gzip, br,
  deflate, zstd, and other. Original header text is never logged.
- `h`: three values: responses with a valid Content-Length, responses without
  Content-Length, and the sum of declared lengths.

These values describe runtime-visible bodies and headers, not wire bytes or
decompression cost. A declared length is not proof of the delivered length.
Successfully parsed data can still fail subsequent business validation.

Normal completed decisions mark the statistics complete for that request path.
An error logs only successful responses observed before sealing the collector,
with `complete: false`. Failed or still-pending responses are not counted. Late
concurrent completions cannot change the emitted snapshot. No extra requests
are awaited merely to complete diagnostics.

Diagnostic failures discard the statistics and retain the original scheduler
behavior. They do not make malformed responses acceptable, change error reasons,
or retry an uncertain dispatch. No response text, URLs, headers, credentials,
article identifiers, or exception messages are added to the log. The original
validated GitHub run ID can still be present in the existing result.

## Interpretation and rollback

Use actual natural `dispatched` events and pair them with official CPU metrics,
the Worker version and the corresponding GitHub/DB batch. Deduplication and
startup timings are not substitutes. Tail's integer CPU milliseconds are less
precise than Analytics microseconds. Timestamp-only correspondence must be
identified as such when no shared request identifier is available.

The extra aggregation and log data have a cost. A diagnostic sample must not be
reported as the uninstrumented Worker's CPU, and local test time or fewer stream
reads do not establish a production CPU saving. This change must not be used to
claim sustained operation below 10 ms.

If diagnostics affect behavior, disable their variable or restore the last
verified Worker version through the official CLI. Preserve ENABLE, DRY_RUN,
Cron, secrets and all existing safety limits. Do not manually trigger collection
to create a sample. Expiry requires no manual intervention; remove this temporary
code during later normal maintenance once the evidence is sufficient.
