import { SITE } from "@aihot/industry/site";
import { Link, redirect, useLoaderData, useSearchParams } from "react-router";
import type { Route } from "./+types/topic";
import type { FeedItemSummary } from "@aihot/contracts/site";
import { RESEARCH_AREAS, RESEARCH_FOCI } from "@aihot/contracts/research";
import { loadOr404, queryString } from "../lib/api.server";
import { breadcrumbLd, pageMeta, titled } from "../lib/seo";
import { Pagination } from "../features/feed/DayList";
import { ResearchList } from "../features/research/ResearchRecord";
interface TopicPageData { topic:{slug:string;name:string;definition:string;total:number;indexable:boolean;related:Array<{slug:string;name:string}>}; items:FeedItemSummary[]; page:number;pageCount:number;filteredTotal:number;area:string|null; }
export function headers() { return { "Cache-Control":"public, max-age=0, s-maxage=60" }; }
export async function loader({ params, request }: Route.LoaderArgs) {
  const page = params.page ? Number(params.page) : 1;
  const sp = new URL(request.url).searchParams;
  if (params.page !== undefined && (!/^\d+$/.test(params.page) || page < 1)) throw new Response("Not found", {status:404});
  if (params.page === "1") throw redirect(`/topics/${params.slug}${sp.size ? "?"+sp : ""}`,308);
  return { data:await loadOr404<TopicPageData>(`/api/site/research/topics/${encodeURIComponent(params.slug)}` + queryString({page,area:sp.get("area")}),{ signal:request.signal }) };
}
export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{title:titled("专题不存在")},{name:"robots",content:"noindex"}];
  const { topic, page } = loaderData.data;
  const path = page > 1 ? `/topics/${topic.slug}/page/${page}` : `/topics/${topic.slug}`;
  return pageMeta({ title:page > 1 ? `${topic.name} · 第 ${page} 页` : topic.name, description:topic.definition,path,noindex:!topic.indexable,jsonLd:breadcrumbLd([{name:SITE.name,path:"/"},{name:"专题",path:"/topics"},{name:topic.name,path:`/topics/${topic.slug}`}]) });
}
export default function TopicPage() {
  const { data } = useLoaderData<typeof loader>(); const [params] = useSearchParams();
  const { topic, items, page,pageCount,area } = data;
  const href = (p:number) => { const sp = new URLSearchParams(params); return (p <= 1 ? `/topics/${topic.slug}` : `/topics/${topic.slug}/page/${p}`) + (sp.size ? "?"+sp : ""); };
  const areaHref = (key:string|null) => `/topics/${topic.slug}` + (key ? `?area=${key}` : "");
  const focus = RESEARCH_FOCI.find(f => f.key === topic.slug);
  const libraryHref = focus ? `/all?focus=${focus.key}` : `/all?topic=${topic.slug}`;
  const groups = [...RESEARCH_AREAS.map(a => ({...a,items:items.filter(i => i.research?.areas.includes(a.key))})),{key:"pending",label:"研究环节待整理",description:"",items:items.filter(i => !i.research?.areas.length)}];
  return <div className="topic-page"><header className="topic-intro"><Link to="/topics" className="journal-kicker">← ALL SUBJECTS</Link><h1>{topic.name}</h1><p>{topic.definition}</p><div className="topic-status"><span><strong>{topic.total}</strong> 条已收录资料</span><Link to={libraryHref}>在资料库组合筛选 ↗</Link></div></header>
    <nav className="topic-area-nav" aria-label="按研究环节查看"><Link to={areaHref(null)} aria-current={!area ? "true":undefined}>全部环节</Link>{RESEARCH_AREAS.map(a => <Link to={areaHref(a.key)} key={a.key} aria-current={area === a.key ? "true":undefined}>{a.label}</Link>)}</nav>
    <p className="topic-scope">当前条件共 {data.filteredTotal} 条资料；下方按研究环节整理本页结果，跨环节研究可重复出现。</p>
    {groups.filter(g => g.items.length).map(g => <section className="topic-section" key={g.key}><div className="section-heading"><h2>{g.label}</h2><span>本页 {g.items.length} 条</span></div><ResearchList items={g.items} /></section>)}
    {!items.length && <div className="library-empty"><h2>这个方向暂时没有匹配资料</h2><p>研究结构会逐步补齐，你可以浏览其他环节或资料库。</p><Link to={areaHref(null)}>查看全部环节 →</Link></div>}
    <Pagination page={page} pageCount={pageCount} href={href} />
    {!!topic.related.length && <aside className="related-subjects"><h2>相关方向</h2>{topic.related.map(t => <Link to={`/topics/${t.slug}`} key={t.slug}>{t.name} ↗</Link>)}</aside>}
  </div>;
}
