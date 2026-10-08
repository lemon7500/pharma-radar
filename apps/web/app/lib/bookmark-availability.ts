export type BookmarkAvailability = "public" | "summary-only" | "unavailable";

const BATCH_SIZE = 50;
const MAX_PARALLEL = 2;
const REQUEST_TIMEOUT_MS = 8_000;

/** The saved-list limit is 500, but a single URL with 500 long legacy IDs exceeds HTTP limits. */
export async function loadBookmarkAvailability(ids: string[], options: {
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  timeoutMs?: number;
} = {}): Promise<Record<string, BookmarkAvailability>> {
  const clean = [...new Set(ids.filter(id => /^[a-zA-Z0-9_-]{1,80}$/.test(id)))].slice(0, 500);
  const results: Record<string, BookmarkAvailability> = Object.create(null);
  const fetcher = options.fetcher ?? fetch;
  let offset = 0;
  const worker = async () => {
    while (offset < clean.length && !options.signal?.aborted) {
      const batch = clean.slice(offset, offset + BATCH_SIZE);
      offset += BATCH_SIZE;
      const controller = new AbortController();
      const cancel = () => controller.abort();
      options.signal?.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(cancel, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
      try {
        const response = await fetcher(`/api/site/items/availability?ids=${encodeURIComponent(batch.join(","))}`, { signal: controller.signal });
        if (!response.ok) continue;
        const body: unknown = await response.json();
        if (controller.signal.aborted || options.signal?.aborted || !body || typeof body !== "object" || Array.isArray(body)) continue;
        const statuses = body as Record<string, unknown>;
        for (const id of batch) {
          const status = Object.hasOwn(statuses, id) ? statuses[id] : undefined;
          if (status === "public" || status === "summary-only" || status === "unavailable") results[id] = status;
        }
      } catch {
        // A failed or timed-out batch cannot prove that its saved articles were withdrawn.
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", cancel);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, Math.ceil(clean.length / BATCH_SIZE)) }, worker));
  return results;
}
