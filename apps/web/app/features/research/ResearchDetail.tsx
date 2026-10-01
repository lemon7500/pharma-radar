import { lazy, Suspense, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { SiteItemDetail } from "@aihot/contracts/site";
import { BASIS_LABELS, DOCUMENT_TYPES, SOURCE_ORIGINS, RESEARCH_CLAIMS } from "@aihot/contracts/research";
import { markRead } from "../../lib/local-state";
import { StarButton } from "../feed/parts";
import { ResearchTags } from "./ResearchRecord";
import { siteUrl } from "../../lib/seo";
const PosterSheet = lazy(() => import("../item/PosterSheet"));
export function ResearchDetail({ item }: { item:SiteItemDetail }) {
  const navigate = useNavigate(); const [message,setMessage] = useState(""); const [poster,setPoster] = useState(false);
  useEffect(() => markRead(item.id),[item.id]);
  const r = item.readingMode === "summary-only" ? null : item.research;
  const b = r?.bibliography;
  const ready = r?.status === "ready";
  const copy = async () => { try { await navigator.clipboard.writeText(`${item.title}\n${siteUrl()}/items/${item.id}`); setMessage("阅读链接已复制"); } catch { setMessage("暂时无法复制，请使用浏览器分享此页面"); } };
  const back = () => window.history.state?.idx > 0 ? navigate(-1) : navigate("/all");
  const form = DOCUMENT_TYPES.find(v => v.key === r?.documentType)?.label || "文献类型待确认";
  const original = item.body?.zh || item.body?.original;
  return <article className="research-detail">
    <div className="reading-topline"><button onClick={back} type="button">← 返回资料</button><span className="journal-kicker">RESEARCH READING NOTE</span></div>
    <header className="research-title"><div className="record-meta"><span>{form}</span><span>{b?.journal || item.source.name}</span>{b?.isPreprint && <span>预印本 · 尚未确认同行评议</span>}</div><h1>{item.title}</h1>{item.originalTitle && item.originalTitle !== item.title && <p className="original-title" lang="en">{item.originalTitle}</p>}<ResearchTags item={item} /></header>
    <div className="reading-layout"><div className="reading-content">
      {item.canonicalId && <p className="mb-6 text-[13px] text-ink-3">同一 DOI 的资料已归并，当前旧入口继续保留。<Link className="text-accent" to={`/items/${item.canonicalId}`}>查看主记录 →</Link></p>}
      <section className="material-scope" aria-labelledby="scope-title"><h2 id="scope-title">本篇导读的材料范围</h2><strong>{r ? BASIS_LABELS[r.basis] : "材料范围待整理"}</strong><p>{ready ? "下方研究信息从已获取材料中整理；不能替代阅读全文和评价研究质量。" : r?.status === "insufficient" ? "当前仅获取标题、过短内容或参考文献列表，暂不生成深入导读。保留文献索引与原文入口，研究方法、结果和证据阶段待确认。" : "研究结构尚未完成整理。没有明确来源支持的信息保留为空，请通过原文核对研究设计与结果。"}</p></section>
      {ready && item.summary && <section className="research-abstract"><h2>阅读概要</h2><p>{item.summary}</p></section>}
      {ready && item.reason && <aside className="reading-significance"><h2>为什么值得读</h2><p>{item.reason}</p></aside>}
      <div className="research-claim-sections">{RESEARCH_CLAIMS.map(c => <section id={`research-${c.key}`} key={c.key}><h2>{c.label}</h2>{ready && r?.claims[c.key] ? <p>{r.claims[c.key]}</p> : <p className="claim-missing">已获取材料未提供足够依据。</p>}</section>)}</div>
      {original && item.readingMode !== "summary-only" && <section className="research-source-body"><h2>{item.body?.zhKind === "translation" ? "来源正文 · AI 翻译" : "已授权展示的来源正文"}</h2><div className="prose" dangerouslySetInnerHTML={{__html:original}} /></section>}
      <section className="research-citation"><h2>引用与原文</h2><p>{b?.authors.length ? b.authors.join(", ") + ". " : ""}{(item.originalTitle || item.title).replace(/[.。]+$/, "")}. {b?.journal || item.source.name}{b?.publishedDate ? `, ${b.publishedDate}` : ""}{b?.doi ? `. DOI: ${b.doi}` : ""}.</p><a href={item.links.original} target="_blank" rel="noopener noreferrer">打开来源原文 ↗</a>{b?.doi && <a href={`https://doi.org/${encodeURI(b.doi)}`} target="_blank" rel="noopener noreferrer">通过 DOI 查看 ↗</a>}</section>
    </div><aside className="reading-rail" aria-label="文献信息与阅读操作">
      <div className="reading-actions"><a href={item.links.original} target="_blank" rel="noopener noreferrer">阅读原文 ↗</a><StarButton item={item} size={44} /><button type="button" onClick={() => void copy()}>复制链接</button><button type="button" onClick={() => setPoster(true)}>分享图</button>{item.markdownAvailable && <a href={`/items/${item.id}/markdown`} download>导出笔记</a>}</div><p className="reading-message" role="status">{message}</p>
      <section><h2>文献信息</h2><dl><dt>作者</dt><dd>{b?.authors.length ? b.authors.join("；") : "待确认"}</dd><dt>期刊／来源</dt><dd>{b?.journal || item.source.name}</dd><dt>发表日期</dt><dd>{b?.publishedDate || (item.publishedAt ? new Date(item.publishedAt).toLocaleDateString("zh-CN",{timeZone:"Asia/Shanghai"}) : "待确认")}</dd><dt>DOI</dt><dd>{b?.doi ? <a href={`https://doi.org/${encodeURI(b.doi)}`} target="_blank" rel="noopener noreferrer" className="mono">{b.doi}</a> : "待确认"}</dd><dt>文献类型</dt><dd>{form}</dd><dt>来源属性</dt><dd>{SOURCE_ORIGINS.find(v => v.key === r?.origin)?.label || "待确认"}</dd><dt>收录时间</dt><dd>{new Date(item.discoveredAt).toLocaleDateString("zh-CN",{timeZone:"Asia/Shanghai"})}</dd></dl></section>
      <section><h2>阅读提示</h2><p>研究阶段说明实验在哪一层开展。体外与动物结果不能直接当作人体疗效，来源属性也不等于证据质量。</p><Link to={`/feedback?item=${item.id}`}>报告元数据或导读问题 ↗</Link></section>
      {!!item.researchSources?.length && <section><h2>收录来源</h2>{item.researchSources.map(s=><a href={s.url} target="_blank" rel="noopener noreferrer" key={s.url+s.name}>{s.name} ↗</a>)}</section>}
    </aside></div>
    {poster && <Suspense fallback={<p role="status">正在准备分享图…</p>}><PosterSheet id={item.id} title={item.title} open={poster} onClose={() => setPoster(false)} /></Suspense>}
  </article>;
}
