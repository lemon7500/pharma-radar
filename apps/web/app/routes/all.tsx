import { Link, useLoaderData, useNavigation, useSearchParams } from "react-router";
import type { Route } from "./+types/all";
import type { PoolResponse } from "@aihot/contracts/site";
import { parseResearchFilters, researchFilterParams } from "@aihot/contracts/research";
import { isCategoryKey, isChannelKey } from "@aihot/contracts/taxonomy";
import { loadOr404, queryString } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { SearchField, hrefWith } from "../features/feed/Filters";
import { Pagination } from "../features/feed/DayList";
import { ResearchList } from "../features/research/ResearchRecord";
import { FacetFilters } from "../features/research/FacetFilters";
import { PublicationRange } from "../features/research/ResearchTimeline";
export async function loader({ request }: Route.LoaderArgs) {
  const sp = new URL(request.url).searchParams;
  const channel = isChannelKey(sp.get("channel")) ? sp.get("channel") : null;
  const category = isCategoryKey(sp.get("category")) ? sp.get("category") : null;
  const fields = { channel, category, tag: sp.get("tag"), topic: sp.get("topic"), q: sp.get("q")?.trim().slice(0,200) || null,
    tab: sp.get("tab") === "relevance" ? "relevance" : null, sort: sp.get("sort") === "oldest" ? "oldest" : null, from:sp.get("from"), to:sp.get("to"), view:sp.get("view") === "selected" ? "selected" : null,
    ...researchFilterParams(parseResearchFilters(sp)), page: Math.min(Math.max(parseInt(sp.get("page") || "1",10) || 1,1),50) };
  return { data: await loadOr404<PoolResponse>("/api/site/pool" + queryString(fields), { signal: request.signal, busyRedirect: "/all/search-busy" }) };
}
export function meta({ loaderData }: Route.MetaArgs) { return pageMeta({ title: loaderData?.data.filters.q ? "检索：" + loaderData.data.filters.q : "资料库", description: "按研究环节、重点专题、内容形式和证据阶段检索药学资料。", path: "/all", noindex: !!loaderData?.data.filters.q }); }
export function headers() { return { "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=30" }; }
export default function AllPage() {
  const { data } = useLoaderData<typeof loader>(); const [params] = useSearchParams(); const navigation = useNavigation();
  const keep = Object.fromEntries([...params].filter(([k]) => !["q","page","cursor","search"].includes(k)));
  const pageHref = (p: number) => { const sp = new URLSearchParams(params); sp.delete("cursor"); sp.delete("search"); p > 1 ? sp.set("page",String(p)) : sp.delete("page"); return "/all" + (sp.size ? "?" + sp : ""); };
  return <div className="library-page">
    <header className="reader-page-header"><div><h1>资料库</h1><p>按研究环节、专题、证据与发表日期组合检索</p></div><SearchField variant="bar" defaultValue={data.filters.q || ""} keep={keep} autoFocus={params.get("search") === "1"} /></header>
    <div className="library-layout"><aside className="library-filter-panel"><FacetFilters /><details className="library-date-panel" open><summary>发表日期</summary><PublicationRange /></details></aside><div className="library-results">
    <div className="library-toolbar"><span aria-live="polite">{data.filters.q && <>“{data.filters.q}” · </>}找到 <strong className="num">{data.total >= 2000 ? "2000+" : data.total}</strong> 条资料</span><nav aria-label="结果排序">
      <Link to={hrefWith("/all",params,{sort:null,tab:null})} aria-current={data.filters.sort !== "oldest" && data.filters.tab !== "relevance" ? "true" : undefined}>发表最新</Link>
      <Link to={hrefWith("/all",params,{sort:"oldest",tab:null})} aria-current={data.filters.sort === "oldest" ? "true" : undefined}>发表最早</Link>
      {data.filters.q && <Link to={hrefWith("/all",params,{tab:"relevance",sort:null})} aria-current={data.filters.tab === "relevance" ? "true" : undefined}>相关度</Link>}
    </nav></div>
    <div aria-busy={navigation.state === "loading"} className={navigation.state === "loading" ? "opacity-60" : ""}>
      {data.items.length ? <ResearchList items={data.items} /> : <div className="library-empty"><h2>暂时没有匹配的资料</h2><p>可以减少筛选条件、换一个关键词，或浏览全部已收录内容。研究结构尚未补齐的资料可能暂不匹配证据筛选。</p><Link to="/all">清除条件，浏览资料库 →</Link></div>}
    </div><Pagination page={data.page} pageCount={data.pageCount} href={pageHref} /></div></div>
  </div>;
}
export function SearchBusy() { return <div className="library-empty"><h1>检索暂时繁忙</h1><p>请稍后重试，或先浏览已有资料。</p><Link to="/all">浏览资料库 →</Link></div>; }
