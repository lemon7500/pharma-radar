// One source-permission read at the HTTP boundary, before a public cache or ETag is used.
// Source updates can happen in a worker or another API process; process-local callbacks alone
// cannot see them. No publication/function adds its own permission polling query.
import { sql } from "../db.ts";

const resets = new Set<() => void>();
let fingerprint: string | null = null;
export function registerPublicCacheReset(reset: () => void) { resets.add(reset); }

export function sourceDependentPublicRoute(method: string, route: string): boolean {
  if (route === "/api/mcp") return method === "GET" || method === "POST";
  if (method !== "GET" && method !== "HEAD") return false;
  return /^\/api\/site\/(research|timeline|pool|items|stories|groups|stats|topics|hot|reports)(?:\/|$)/.test(route)
    || /^\/api\/v1\/(items|hot-topics|stories|dailies|selected)(?:\/|$)/.test(route)
    || route === "/feed.xml" || route.startsWith("/feed/")
    || route === "/items/:id/markdown" || route === "/sitemap.xml"
    || /^\/og\/(items|posters|reports|topics|stories)\//.test(route);
}

export function syncPublicPermissions(): Promise<void> {
  // Do not share a read started before a revocation with a later HTTP request.
  return readPermissions();
}
async function readPermissions(): Promise<void> {
  // updated_at and the persistent epoch also detect revoke/restore cycles returning to the
  // original flags. The aggregate returns one short value, independent of article count.
  const [row] = await sql<{ fingerprint: string }[]>`
    SELECT md5(coalesce(string_agg(concat_ws(':', id, participation_mode, site_fulltext::text,
      syndicate_fulltext::text, updated_at::text), ',' ORDER BY id), '') ||
      coalesce((SELECT value::text FROM settings WHERE key='selected_ledger_epoch'), '')) AS fingerprint FROM sources`;
  if (!row) throw new Error("source permissions unavailable");
  if (fingerprint !== row.fingerprint) {
    for (const reset of resets) reset();
    fingerprint = row.fingerprint;
  }
}
