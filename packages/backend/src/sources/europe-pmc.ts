import { FetchError, type Candidate, type SourceRow } from "./types.ts";
import { fetchJsonData, jsonListCandidates } from "./json-list.ts";

interface Window { from: string; to: string; query: string; cursor: string; read: number; hitCount: number; }
export interface EuropePmcCursor { version: 1; queryKey: string; windows: Window[]; queuedThrough: string; }
const day = (time: number) => new Date(time).toISOString().slice(0, 10);
const validDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v));

export function europePmcQuery(url: string, from: string, to: string): string {
  const query = new URL(url).searchParams.get("query") || "";
  return `${query.replace(/\s*sort_date:[yn]\b/gi, "").replace(/FIRST_PDATE:\[[^\]]+\]/gi, `FIRST_PDATE:[${from} TO ${to}]`)} sort_date:y`;
}
function pageUrl(source: SourceRow, query: string, cursor: string): string {
  const url = new URL(String(source.config.url));
  url.searchParams.delete("sort_date");
  for (const [key, value] of Object.entries({ query, cursorMark: cursor, pageSize: "15", format: "json", resultType: "core" })) url.searchParams.set(key, value);
  return url.toString();
}

/** Three requests at most: newest page first, then saved fixed-date windows. The caller
 * commits the proposed cursor only after all candidates have been stored successfully.
 * Failed pages throw without altering source.cursor; partial inserts are safe to replay.
 */
export async function fetchEuropePmc(source: SourceRow, options: {
  now?: number; read?: (url: string) => Promise<Record<string, any>>;
} = {}): Promise<{ candidates: Candidate[]; cursor: EuropePmcCursor; detail: Record<string, unknown> }> {
  const now = options.now ?? Date.now(), today = day(now), from = day(now - 7 * 86_400_000);
  const queryKey = europePmcQuery(String(source.config.url), "DATE_FROM", "DATE_TO");
  const saved = source.cursor?.europePmc;
  // A changed source query starts a new bounded window instead of applying an old cursor to it.
  const valid = saved?.version === 1 && saved.queryKey === queryKey && Array.isArray(saved.windows) && validDay(saved.queuedThrough)
    && saved.windows.every((w: Window) => validDay(w.from) && validDay(w.to) && typeof w.query === "string" && typeof w.cursor === "string" && w.cursor.length > 0 && Number.isFinite(w.read) && Number.isFinite(w.hitCount));
  const state: EuropePmcCursor = valid ? structuredClone(saved) : { version: 1, queryKey, windows: [], queuedThrough: today };
  const makeWindow = (start: string, end: string): Window => ({ from: start, to: end, query: europePmcQuery(String(source.config.url), start, end), cursor: "*", read: 0, hitCount: 0 });
  if (!state.windows.length) { state.windows.push(makeWindow(from, today)); state.queuedThrough = today; }
  else if (state.queuedThrough < today) {
    // Date boundaries overlap deliberately: a repeated paper is a discovery, never a missing day.
    state.windows.push(makeWindow(state.queuedThrough, today)); state.queuedThrough = today;
  }
  const read = options.read ?? (url => fetchJsonData(source, url));
  let pages = 0, seen = 0;
  const candidates: Candidate[] = [];
  const fetchPage = async (query: string, cursor: string) => {
    const data = await read(pageUrl(source, query, cursor)); pages++;
    if (!Array.isArray(data.resultList?.result)) throw new FetchError("Europe PMC missing result list");
    const mapped = jsonListCandidates(source, data);
    if (mapped.length !== data.resultList.result.length) throw new FetchError("Europe PMC unmapped records; cursor retained");
    candidates.push(...mapped); seen += data.resultList.result.length;
    const hitCount = Number(data.hitCount);
    if (!Number.isFinite(hitCount) || hitCount < 0) throw new FetchError("Europe PMC invalid hit count");
    const next = typeof data.nextCursorMark === "string" && data.nextCursorMark !== cursor ? data.nextCursorMark : null;
    if (data.resultList.result.length === 15 && !next && hitCount > 15) throw new FetchError("Europe PMC missing continuation cursor");
    return { next, hitCount, count: data.resultList.result.length };
  };
  const advance = (window: Window, result: Awaited<ReturnType<typeof fetchPage>>) => {
    window.read += result.count; window.hitCount = result.hitCount;
    if (!result.count || !result.next) state.windows.shift();
    else window.cursor = result.next;
  };
  const latestQuery = europePmcQuery(String(source.config.url), from, today);
  const latest = await fetchPage(latestQuery, "*");
  // Reuse this page when it is exactly the start of the pending window.
  if (state.windows[0]?.query === latestQuery && state.windows[0]?.cursor === "*") advance(state.windows[0], latest);
  while (pages < 3 && state.windows.length) {
    const window = state.windows[0]!;
    advance(window, await fetchPage(window.query, window.cursor));
  }
  const unique = [...new Map(candidates.map(c => [c.bibliography?.doi ?? c.url, c])).values()];
  return { candidates: unique, cursor: state, detail: {
    provider: "europe-pmc", pages, pageSize: 15, read: seen, duplicates: candidates.length - unique.length,
    latestHitCount: latest.hitCount, truncated: state.windows.length > 0,
    pendingWindows: state.windows.map(w => ({ from: w.from, to: w.to, read: w.read, hitCount: w.hitCount })),
  } };
}
