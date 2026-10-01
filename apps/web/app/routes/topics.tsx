import { Link, useLoaderData } from "react-router";
import { apiGet } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { RESEARCH_FOCI, RESEARCH_AREAS } from "@aihot/contracts/research";
interface TopicSummary { slug:string; name:string; group:string; definition:string; total:number; recent:number; latestAt:string|null; }
export async function loader({ request }: { request:Request }) { return apiGet<{topics:TopicSummary[]}>("/api/site/research/topics", { signal:request.signal }); }
export function meta() { return pageMeta({ title:"专题", description:"持续追踪中药与天然产物、AI 药物研发及药学研究方向。", path:"/topics" }); }
export function headers() { return { "Cache-Control":"public, max-age=0, s-maxage=60" }; }
export default function TopicsPage() {
  const { topics } = useLoaderData<typeof loader>();
  const featured = RESEARCH_FOCI.map(f => ({ ...f, ...topics.find(t => t.slug === f.key) }));
  const others = topics.filter(t => !RESEARCH_FOCI.some(f => f.key === t.slug));
  return <div className="topics-page">
    <header className="topic-intro"><span className="journal-kicker">RESEARCH SUBJECTS</span><h1>持续追踪研究方向</h1><p>专题可以交叉归属。AI 筛选天然活性成分的研究，会同时出现在两个重点专题中。</p></header>
    <section className="featured-topics" aria-label="重点专题">{featured.map((f,i) => <Link key={f.key} to={`/topics/${f.key}`}><span className="subject-number">FOCUS 0{i+1}</span><h2>{f.label}</h2><p>{f.description}</p><div><strong>{f.total ?? 0}</strong> 条资料<span>{f.recent ?? 0} 条近 30 日更新 ↗</span></div></Link>)}</section>
    <section className="topic-pathways"><div className="section-heading"><h2>按研究环节探索</h2><span>从发现走向转化</span></div><div>{RESEARCH_AREAS.map((a,i) => <Link to={`/all?area=${a.key}`} key={a.key}><span className="subject-number">0{i+1}</span><h3>{a.label}</h3><p>{a.description}</p><span>检索资料 ↗</span></Link>)}</div></section>
    <section className="topic-directory"><div className="section-heading"><h2>方向与关键词索引</h2><span>保留已有专题入口</span></div>{others.map(t => <Link key={t.slug} to={`/topics/${t.slug}`}><h3>{t.name}</h3><p>{t.definition}</p><span><strong>{t.total}</strong> 条资料 · {t.recent} 条近期更新 ↗</span></Link>)}</section>
  </div>;
}
