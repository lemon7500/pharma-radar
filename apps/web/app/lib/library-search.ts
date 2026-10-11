import { parseResearchFilters, researchFilterParams } from "@aihot/contracts/research";
import { isCategoryKey, isChannelKey } from "@aihot/contracts/taxonomy";

/** The same public search fields are used for the API request and a shareable retry. */
export function librarySearchFields(params: URLSearchParams): Record<string, string | number | null> {
  return {
    channel: isChannelKey(params.get("channel")) ? params.get("channel") : null,
    category: isCategoryKey(params.get("category")) ? params.get("category") : null,
    tag: params.get("tag"), topic: params.get("topic"), q: params.get("q")?.trim().slice(0, 200) || null,
    tab: params.get("tab") === "relevance" ? "relevance" : null,
    sort: params.get("sort") === "oldest" ? "oldest" : null,
    from: params.get("from"), to: params.get("to"), view: params.get("view") === "selected" ? "selected" : null,
    ...researchFilterParams(parseResearchFilters(params)),
    page: Math.min(Math.max(parseInt(params.get("page") || "1", 10) || 1, 1), 50),
  };
}

export function librarySearchHref(params: URLSearchParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(librarySearchFields(params))) {
    if (value === null || value === "" || (key === "page" && value === 1)) continue;
    query.set(key, String(value));
  }
  return "/all" + (query.size ? `?${query}` : "");
}

/** Only an exact library pathname is accepted; query values can never choose another target. */
export function safeLibraryRetryHref(value: string | null): string {
  if (!value || value.includes("#") || (value !== "/all" && !value.startsWith("/all?"))) return "/all";
  return librarySearchHref(new URLSearchParams(value.slice(4)));
}

export function libraryBusyHref(params: URLSearchParams): string {
  return "/all/search-busy?" + new URLSearchParams({ retry: librarySearchHref(params) });
}
