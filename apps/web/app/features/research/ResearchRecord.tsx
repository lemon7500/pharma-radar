import { Link } from "react-router";
import type { FeedItemSummary } from "@aihot/contracts/site";
import { BASIS_LABELS, DOCUMENT_TYPES, EVIDENCE_STAGES, RESEARCH_AREAS, RESEARCH_FOCI } from "@aihot/contracts/research";
import { StarButton } from "../feed/parts";
import { markRead, useReadSet } from "../../lib/local-state";
import { publicationTime, publicationLabel } from "@aihot/contracts/publication-time";
export function ResearchTags({ item }: { item: FeedItemSummary }) {
  const r = item.research;
  if (!r) return <span className="research-label">研究结构待整理</span>;
  return <div className="research-tags">
    {r.foci.map(k => <Link key={k} to={`/all?focus=${k}`} className="focus-label">{RESEARCH_FOCI.find(v => v.key === k)?.label}</Link>)}
    {r.areas.slice(0, 2).map(k => <Link key={k} to={`/all?area=${k}`}>{RESEARCH_AREAS.find(v => v.key === k)?.label}</Link>)}
    {r.evidenceStages.map(k => <span key={k} className="evidence-label">{EVIDENCE_STAGES.find(v => v.key === k)?.label}研究</span>)}
    {r.clinicalPhase && <span>临床 {r.clinicalPhase} 期</span>}
    {!r.evidenceStages.length && <span>证据阶段待确认</span>}
  </div>;
}
export function ResearchRecord({ item, variant = "library", read = false, onOpen, timeline = false }: { item: FeedItemSummary; variant?: "library" | "editorial"; read?: boolean; onOpen?: (id: string) => void; timeline?: boolean }) {
  const r = item.research;
  const form = DOCUMENT_TYPES.find(v => v.key === r?.documentType)?.label;
  const journal = r?.bibliography.journal || item.source.name;
  const time = item.publicationTime ?? publicationTime(item);
  return <article className={`research-record ${variant} ${read ? "is-read" : ""}`} data-item-id={item.id}>
    <div className="record-meta"><span className="record-source-icon" aria-hidden="true">{item.source.iconUrl ? <img src={item.source.iconUrl} srcSet={item.source.iconSrcSet} alt="" loading="lazy" /> : journal.slice(0,1)}</span><span className="record-journal">{journal}</span><span>{form || "研究资料"}</span>{item.selected && <span className="selected-label">精选</span>}{!timeline && <time dateTime={time.date || undefined}>{publicationLabel(time)} · 发表</time>}</div>
    <div className="record-title-row"><h3><Link to={`/items/${item.id}`} onClick={() => onOpen?.(item.id)}>{item.title}</Link></h3><StarButton item={item} size={44} /></div>
    {item.summary && r?.status === "ready" && <p className="record-summary">{item.summary}</p>}
    {r?.status === "pending" && <p className="record-summary text-ink-3">研究导读待整理，可先查看文献索引与原文。</p>}
    <ResearchTags item={item} />
    <div className="record-basis"><span className={r?.status === "insufficient" ? "material-warning" : ""}>{r ? BASIS_LABELS[r.basis] : "材料范围待整理"}</span>{read && <span>已读</span>}</div>
    <details className="record-information"><summary>{!!item.additionalSourceCount && `另有 ${item.additionalSourceCount} 个收录来源 · `}文献信息与时间</summary><dl><dt>原始发表</dt><dd>{publicationLabel(time)}{time.precision === "day" && " · 来源提供日期"}</dd>{item.discoveredAt && <><dt>本站收录</dt><dd>{new Date(item.discoveredAt).toLocaleString("zh-CN", {timeZone:"Asia/Shanghai", hour12:false})} (UTC+08:00)</dd></>}{r?.bibliography.doi && <><dt>DOI</dt><dd className="mono">{r.bibliography.doi}</dd></>}{r?.bibliography.authors.length ? <><dt>作者</dt><dd>{r.bibliography.authors.slice(0,3).join("；")}{r.bibliography.authors.length > 3 && " 等"}</dd></> : null}<dt>收录来源</dt><dd>{item.source.name}{!!item.additionalSourceCount && <Link to={`/items/${item.id}#research-sources`}> · 查看全部来源 ↗</Link>}</dd></dl></details>{item.story && <Link to={`/story/${item.story.publicId}`} className="record-information inline-block">查看相关进展 →</Link>}
    {variant === "editorial" && item.reason && r?.status === "ready" && <p className="record-reason"><span>阅读意义</span>{item.reason}</p>}
  </article>;
}
export function ResearchList({ items, variant = "library" }: { items: FeedItemSummary[]; variant?: "library" | "editorial" }) {
  const read = useReadSet();
  return <div className="research-list">{items.map(item => <ResearchRecord key={item.id} item={item} variant={variant} read={read.has(item.id)} onOpen={markRead} />)}</div>;
}
