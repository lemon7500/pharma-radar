import { Link, useLoaderData, useSearchParams, redirect, data as withHeaders } from "react-router";
import type { Route } from "./+types/home";
import type { HotStripEntry, PoolResponse } from "@aihot/contracts/site";
import { SITE } from "@aihot/industry/site";
import { loadOr404, releaseBoundCache } from "../lib/api.server";
import { organizationLd, pageMeta } from "../lib/seo";
import { SearchField, hrefWith } from "../features/feed/Filters";
import { Pagination } from "../features/feed/DayList";
import { ResearchTimeline, PublicationNavigator } from "../features/research/ResearchTimeline";
interface Overview { refreshAt:string|null; hot:HotStripEntry[]|null; total:number; updatedAt:string|null; foci:Array<{key:string;label:string;description:string;total:number}>; areas:Array<{key:string;label:string;total:number}>; }
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  if (["q", "search", "category", "channel", "tag", "topic", "area", "evidence", "docType", "origin"].some(k => url.searchParams.has(k))) throw redirect("/all" + url.search);
  const poolParams = new URLSearchParams(url.searchParams); poolParams.delete("sort"); poolParams.delete("tab");
  const upstream = new Headers();
  const [overview, pool] = await Promise.all([
    loadOr404<Overview>("/api/site/research/overview", {signal:request.signal,responseHeaders:upstream}),
    loadOr404<PoolResponse>("/api/site/pool" + (poolParams.size ? "?"+poolParams : ""), {signal:request.signal}),
  ]);
  return withHeaders({overview,pool},{headers:releaseBoundCache(overview.refreshAt,60,Date.now(),upstream)});
}
export function meta() { return pageMeta({title:SITE.homeTitle,rawTitle:true,path:"/",jsonLd:organizationLd()}); }
export function headers({loaderHeaders}:Route.HeadersArgs) { return loaderHeaders; }
export default function Home() {
  const {overview,pool} = useLoaderData<typeof loader>(); const [params] = useSearchParams();
  const selected = !!pool.filters.selectedOnly;
  const pageHref = (page:number) => { const sp = new URLSearchParams(params); page > 1 ? sp.set("page",String(page)) : sp.delete("page"); return "/"+(sp.size ? "?"+sp : ""); };
  const focusValues = (params.get("focus") || "").split(",").filter(Boolean);
  const focusHref = (key:string) => hrefWith("/",params,{focus:(focusValues.includes(key) ? focusValues.filter(v => v !== key) : [...focusValues,key]).join(",") || null});
  return <div className="journal-home">
    <header className="reader-page-header"><div><h1>研究导读</h1><p>按原始发表时间追踪药学研究 · 精确时刻统一为 UTC+08:00</p></div><SearchField variant="bar" /></header>
    <div className="reader-switches"><nav aria-label="资料范围"><Link to={hrefWith("/",params,{view:null})} aria-current={!selected ? "page":undefined}>全部资料</Link><Link to={hrefWith("/",params,{view:"selected"})} aria-current={selected ? "page":undefined}>编辑精选</Link></nav><nav aria-label="重点专题筛选">{overview.foci.map(f => <Link to={focusHref(f.key)} key={f.key} aria-current={focusValues.includes(f.key) ? "true":undefined}>{f.label}</Link>)}{params.size > 0 && <Link to="/">清除条件</Link>}</nav></div>
    <div className="reader-home-layout"><div className="reader-home-feed">
      {!!overview.hot?.length && <section className="reader-hot-strip" aria-label="近期研究热点"><div><h2>近期关注</h2><Link to="/hot">查看热点 →</Link></div><ol>{overview.hot.slice(0,3).map(h => <li key={h.rank}><span>{h.rank}</span><Link to={h.storyPublicId ? `/story/${h.storyPublicId}` : h.itemId ? `/items/${h.itemId}` : "/hot"}>{h.title}</Link><small>{h.participantCount} 个来源参与</small></li>)}</ol><p>反映已接入信源的近期关注度。</p></section>}
      <div className="timeline-result-count">{selected ? "编辑精选" : "全部资料"} · {pool.total} 条 · 按发表日期从新到旧</div>
      {pool.items.length ? <ResearchTimeline items={pool.items} editorial={selected} /> : <div className="library-empty"><h2>{selected ? "当前条件下暂无编辑精选" : "当前条件下暂无资料"}</h2><p>{selected ? "已收录资料保留各自材料范围与整理状态，可先在全部资料中阅读。" : "可以放宽日期范围或减少专题筛选。"}</p><Link to={hrefWith("/",params,{view:null,focus:null,from:null,to:null})}>浏览全部资料 →</Link></div>}
      <Pagination page={pool.page} pageCount={pool.pageCount} href={pageHref} />
    </div><aside className="reader-home-rail" aria-label="专题与发表日期索引"><section><h2>重点专题</h2>{overview.foci.map(f => <Link key={f.key} to={`/topics/${f.key}`} className="reader-focus-link"><h3>{f.label}</h3><p>{f.description}</p><span>{f.total} 条资料 →</span></Link>)}</section><PublicationNavigator items={pool.items} /><section className="area-index"><h2>研究环节</h2>{overview.areas.map(a => <Link to={`/all?area=${a.key}`} key={a.key}><span>{a.label}</span><span>{a.total}</span></Link>)}</section><p className="index-status">已收录 {overview.total} 条资料{overview.updatedAt && <span>索引更新 {new Date(overview.updatedAt).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false})}</span>}</p></aside></div>
  </div>;
}
