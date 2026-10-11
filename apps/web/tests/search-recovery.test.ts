import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "react-dom";
import "react/jsx-runtime";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { transformSync } from "rolldown/utils";
import { FACET_GROUPS } from "@aihot/contracts/research";
import type { PoolResponse } from "@aihot/contracts/site";
import { libraryBusyHref, librarySearchFields, librarySearchHref, safeLibraryRetryHref } from "../app/lib/library-search.ts";

// Exercise the real loader and views with controlled local data; no service or network calls.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      const url = new URL(specifier, context.parentURL);
      if (!/\.(?:tsx?|m?js|json)$/.test(url.pathname)) for (const suffix of [".ts", ".tsx"]) {
        const candidate = new URL(url.href + suffix);
        if (existsSync(candidate)) return nextResolve(candidate.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) return { format: "module", source: "export default {};", shortCircuit: true };
    if (url.startsWith("file:") && url.endsWith(".tsx")) {
      const result = transformSync(fileURLToPath(url), readFileSync(new URL(url), "utf8"), { jsx: { runtime: "automatic" }, tsconfig: false });
      if (result.errors.length) throw new AggregateError(result.errors, "Could not render the TSX component");
      return { format: "module", source: result.code, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
after(() => hooks.deregister());
const { loader, default: AllPage, SearchBusy } = await import("../app/routes/all.tsx");
const { PageLoadError, currentPageRetryHref } = await import("../app/components/ui/PageLoadError.tsx");
const { ErrorBoundary } = await import("../app/root.tsx");

const pool = (q: string): PoolResponse => ({
  filters: { channel: "all", category: null, tag: null, topic: null, q, tab: "time", sort: "newest" },
  items: [], page: 1, pageCount: 1, total: 0, todayCount: 0, freshness: "fresh", generatedAt: "2026-10-11T00:00:00Z",
});
const render = (router: ReturnType<typeof createMemoryRouter>) => renderToStaticMarkup(createElement(RouterProvider, { router }));
function idle(router: ReturnType<typeof createMemoryRouter>): Promise<void> {
  if (router.state.initialized && router.state.navigation.state === "idle") return Promise.resolve();
  return new Promise(resolve => { const unsubscribe = router.subscribe(state => { if (state.initialized && state.navigation.state === "idle") { unsubscribe(); resolve(); } }); });
}

test("shareable retries use the loader's scalar and multi-facet normalization while preserving dates, sorting and paging", () => {
  const params = new URLSearchParams("q=%20CAR-T%20&q=ignored&sort=oldest&page=51&from=2026-01-01&to=2026-10-11&view=selected&tab=relevance&search=1&cursor=stale&returnTo=https://outside.example&channel=invalid");
  for (const group of FACET_GROUPS) {
    const first = group.values[0]!.key, last = group.values.at(-1)!.key;
    params.append(group.param, `${first},bad-value,${last}`);
    params.append(group.param, first);
  }
  const href = librarySearchHref(params);
  const restored = new URL(href, "http://local").searchParams;
  assert.equal(restored.get("q"), "CAR-T");
  assert.equal(restored.get("sort"), "oldest");
  assert.equal(restored.get("page"), "50");
  assert.equal(restored.get("from"), "2026-01-01");
  assert.equal(restored.get("to"), "2026-10-11");
  assert.equal(restored.get("view"), "selected");
  assert.equal(restored.get("tab"), "relevance");
  for (const group of FACET_GROUPS) assert.equal(restored.get(group.param), [...new Set([group.values[0]!.key, group.values.at(-1)!.key])].join(","));
  for (const key of ["search", "cursor", "returnTo", "channel"]) assert.equal(restored.has(key), false);
  assert.deepEqual(librarySearchFields(restored), librarySearchFields(params));
  assert.equal(librarySearchHref(new URLSearchParams("page=-9&q=%20%20")), "/all");
  assert.equal(new URL(librarySearchHref(new URLSearchParams({ q: "x".repeat(201) })), "http://local").searchParams.get("q")!.length, 200);
});

test("busy retry targets reject external, script, encoded and non-library paths", () => {
  for (const target of [null, "", "//outside.example/all?q=x", "https://outside.example/all?q=x", "javascript:alert(1)", "/all/../admin", "/all%2f..%2fadmin", "/all\\..\\admin", "/all-other?q=x", "/all/search-busy?retry=/all", "%2Fall?q=x", "/all?q=x#fragment", " /all?q=x"]) {
    assert.equal(safeLibraryRetryHref(target), "/all", `unsafe target: ${target}`);
  }
  const values = ["//outside.example", "javascript:alert(1)", "#literal", "药学与天然产物"];
  for (const q of values) {
    const href = safeLibraryRetryHref("/all?" + new URLSearchParams({ q, returnTo: "//outside.example" }));
    const url = new URL(href, "http://local");
    assert.equal(url.origin, "http://local"); assert.equal(url.pathname, "/all");
    assert.equal(url.hash, ""); assert.equal(url.searchParams.get("q"), q); assert.equal(url.searchParams.has("returnTo"), false);
  }
});

test("a busy API response redirects to a recovery page whose retry executes the same normalized request", async () => {
  const original = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async input => { requests.push(String(input)); return requests.length === 1 ? Response.json({ code: "search_busy" }, { status: 503 }) : Response.json(pool("__busy__")); };
  try {
    const params = new URLSearchParams({ q: " __busy__ ", focus: "tcm-natural-products", area: "mechanisms", sort: "oldest", page: "2", from: "2026-01-01", to: "2026-10-11" });
    let recovery = "";
    await assert.rejects(loader({ request: new Request("http://local/all?" + params), params: {}, context: {} } as Parameters<typeof loader>[0]), error => {
      assert.ok(error instanceof Response); assert.equal(error.status, 302);
      recovery = error.headers.get("Location")!; return true;
    });
    assert.equal(new URL(recovery, "http://local").pathname, "/all/search-busy");
    const retry = safeLibraryRetryHref(new URL(recovery, "http://local").searchParams.get("retry"));
    assert.equal(recovery, libraryBusyHref(params));
    const restored = new URL(retry, "http://local").searchParams;
    for (const key of ["focus", "area", "sort", "page", "from", "to"]) assert.equal(restored.get(key), params.get(key));
    assert.equal(restored.get("q"), "__busy__");
    await loader({ request: new Request("http://local" + retry), params: {}, context: {} } as Parameters<typeof loader>[0]);
    assert.equal(requests.length, 2); assert.equal(requests[0], requests[1], "retry preserves the actual API request, not just the label");
    const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [recovery] }, createElement(SearchBusy)));
    assert.ok(html.includes("按原条件重试")); assert.ok(html.includes("浏览全部资料"));
    assert.ok(html.includes(`href="${retry.replaceAll("&", "&amp;")}"`));
    const hostile = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ["/all/search-busy?retry=" + encodeURIComponent("//outside.example/all")] }, createElement(SearchBusy)));
    assert.ok(!hostile.includes("outside.example")); assert.ok(hostile.includes('href="/all"'));
  } finally { globalThis.fetch = original; }
});

test("temporary failures render a same-page reload link usable without JavaScript while 404s do not encourage retries", () => {
  const path = "/all", search = "?q=__error__&focus=tcm-natural-products&area=mechanisms&sort=oldest&page=2";
  const retryHref = currentPageRetryHref(path, search);
  const html = (status: number) => renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [retryHref] }, createElement(PageLoadError, { status, retryHref })));
  assert.ok(html(503).includes("重新加载此页"));
  assert.ok(html(503).includes(`href="${retryHref.replaceAll("&", "&amp;")}"`));
  assert.ok(html(503).includes("保存在当前浏览器的收藏"));
  assert.ok(!html(503).includes("已经加载过的内容不受影响"));
  assert.ok(!html(404).includes("重新加载此页"));
  assert.ok(html(404).includes("内容已不再公开"));
  for (const pathname of ["//outside.example/path", "/\\outside.example/path", "https://outside.example/path", "javascript:alert(1)", "/all?redirect=outside", "/all#x", "/all\n"]) assert.equal(currentPageRetryHref(pathname, search), "/");
  assert.equal(currentPageRetryHref("/item/paper-id", "?from=all&page=2"), "/item/paper-id?from=all&page=2");
  assert.equal(currentPageRetryHref("/all", "//outside.example"), "/all");
});

test("slow library navigation announces pending work without replacing the old result, then clears on success or cancellation", async () => {
  const releases = new Map<string, (data: { data: PoolResponse }) => void>();
  const router = createMemoryRouter([{ path: "/all", Component: AllPage, loader: ({ request }) => {
    const q = new URL(request.url).searchParams.get("q") || "old";
    if (q.startsWith("slow")) return new Promise<{ data: PoolResponse }>(resolve => releases.set(q, resolve));
    return { data: pool(q) };
  } }], { initialEntries: ["/all?q=old&focus=tcm-natural-products"] });
  try {
    await idle(router);
    assert.ok(!render(router).includes("上一次的结果"));
    const pending = router.navigate("/all?q=slow-next&focus=tcm-natural-products");
    const loading = render(router);
    assert.ok(loading.includes('role="status"')); assert.ok(loading.includes('aria-busy="true"'));
    assert.ok(loading.includes("下面暂时保留上一次的结果"));
    assert.ok(loading.includes("“old”")); assert.ok(!loading.includes("“slow-next”"));
    releases.get("slow-next")!({ data: pool("slow-next") }); await pending; await idle(router);
    const completed = render(router);
    assert.ok(!completed.includes("上一次的结果")); assert.ok(completed.includes('aria-busy="false"'));
    assert.ok(completed.includes("“slow-next”"));
    const cancelled = router.navigate("/all?q=slow-cancel");
    assert.ok(render(router).includes("上一次的结果"));
    await router.navigate("/all?q=after-cancel"); await idle(router);
    assert.ok(!render(router).includes("上一次的结果"));
    assert.ok(render(router).includes("“after-cancel”"));
    releases.get("slow-cancel")!({ data: pool("slow-cancel") }); await cancelled;
    assert.ok(render(router).includes("“after-cancel”"), "a cancelled result must not replace the newer query");
  } finally { router.dispose(); }
});

test("a slow request failing through the real root boundary clears pending status and preserves its reload URL", async () => {
  let fail!: (error: Response) => void;
  const href = "/all?q=slow-error&focus=tcm-natural-products&area=mechanisms&sort=oldest&page=2";
  const router = createMemoryRouter([{ id: "root", path: "/all", Component: AllPage, ErrorBoundary, loader: ({ request }) => {
    if (new URL(request.url).searchParams.get("q") === "slow-error") return new Promise((_resolve, reject) => { fail = reject; });
    return { data: pool("old") };
  } }], { initialEntries: ["/all?q=old"] });
  try {
    await idle(router);
    const pending = router.navigate(href);
    assert.ok(render(router).includes("上一次的结果"));
    fail(new Response("unavailable", { status: 503 })); await pending; await idle(router);
    const failed = render(router);
    assert.ok(!failed.includes("上一次的结果")); assert.ok(!failed.includes('aria-busy="true"'));
    assert.ok(failed.includes("重新加载此页"));
    assert.ok(failed.includes(`href="${href.replaceAll("&", "&amp;")}"`));
    assert.ok(failed.includes("保存在当前浏览器的收藏"));
  } finally { router.dispose(); }
});
