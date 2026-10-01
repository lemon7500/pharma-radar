import { Link, useLoaderData, redirect, data as withHeaders } from "react-router";
import type { Route } from "./+types/home";
import type { FeedItemSummary } from "@aihot/contracts/site";
import { SITE } from "@aihot/industry/site";
import { loadOr404, releaseBoundCache } from "../lib/api.server";
import { organizationLd, pageMeta } from "../lib/seo";
import { ResearchList } from "../features/research/ResearchRecord";
import { SearchField } from "../features/feed/Filters";
interface Overview { refreshAt:string|null; selected: FeedItemSummary[]; latest: FeedItemSummary[]; total: number; updatedAt: string | null; foci: Array<{ key: string; label: string; description: string; total: number }>; areas: Array<{ key: string; label: string; description: string; total: number }>; }
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  if (["category", "channel", "tag", "q", "topic", "area", "focus", "evidence", "docType", "origin"].some(k => url.searchParams.has(k))) throw redirect("/all" + url.search);
  const upstream = new Headers();
  const overview = await loadOr404<Overview>("/api/site/research/overview", { signal: request.signal,responseHeaders:upstream });
  return withHeaders(overview,{headers:releaseBoundCache(overview.refreshAt,60,Date.now(),upstream)});
}
export function meta() { return pageMeta({ title: SITE.homeTitle, path: "/", jsonLd: organizationLd() }); }
export function headers({loaderHeaders}:Route.HeadersArgs) { return loaderHeaders; }
export default function Home() {
  const data = useLoaderData<typeof loader>();
  return <div className="journal-home">
    <header className="editorial-intro"><div><span className="journal-kicker">THE RESEARCH READING INDEX</span><h1>从草木到算法，<br />读懂药物研究的进展。</h1><p>追踪中药、天然产物与现代药学。看研究做了什么，也看证据能支持什么。</p></div><div className="intro-search"><SearchField variant="bar" /><p>检索中文导读、原文标题、作者、期刊或 DOI</p></div></header>
    <div className="editorial-layout"><div>
      <section aria-labelledby="selected-heading"><div className="section-heading"><div><span className="journal-kicker">EDITOR'S READING</span><h2 id="selected-heading">研究导读</h2></div><Link to="/all">浏览资料库 ↗</Link></div>
        {data.selected.length ? <ResearchList items={data.selected} variant="editorial" /> : <div className="editorial-empty"><p>当前还没有完成研究结构整理的精选资料。</p><p>先浏览最新收录，或进入专题寻找感兴趣的研究。</p><Link to="/all">查看已收录资料 →</Link></div>}
      </section>
      <section className="latest-section" aria-labelledby="latest-heading"><div className="section-heading"><div><span className="journal-kicker">RECENTLY INDEXED</span><h2 id="latest-heading">最新收录</h2></div><span>按资料时间排列</span></div>
        {data.latest.length ? <ResearchList items={data.latest} /> : <div className="editorial-empty"><p>正在等待信源更新。你可以先查看专题与已有资料。</p><Link to="/topics">浏览专题 →</Link></div>}
      </section>
    </div><aside className="editorial-rail" aria-label="研究方向索引">
      <section><span className="journal-kicker">FEATURED SUBJECTS</span><h2>重点专题</h2>{data.foci.map((f,i) => <Link key={f.key} to={"/topics/" + f.key} className="featured-subject"><span className="subject-number">0{i+1}</span><h3>{f.label}</h3><p>{f.description}</p><span>{f.total} 条资料 · 进入专题 →</span></Link>)}</section>
      <section className="area-index"><span className="journal-kicker">RESEARCH PATHWAYS</span><h2>按研究环节阅读</h2>{data.areas.map(a => <Link key={a.key} to={"/all?area=" + a.key}><span>{a.label}</span><span className="num">{a.total} ↗</span></Link>)}</section>
      <section className="reading-note"><h3>阅读时请留意</h3><p>计算、体外、动物和临床研究回答不同的问题。来源属性与 AI 筛选结果均不代表证据质量。</p><p>本站提供研究摘要与原文索引；重要结论请核对原文。</p></section>
      <div className="index-status">已收录 <strong>{data.total}</strong> 条资料{data.updatedAt && <span>更新于 {new Date(data.updatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit" })}</span>}</div>
    </aside></div>
  </div>;
}
