import { Link } from "react-router";
import type { FeedItemSummary } from "@aihot/contracts/site";
import { BASIS_LABELS, DOCUMENT_TYPES, EVIDENCE_STAGES, RESEARCH_AREAS, RESEARCH_FOCI } from "@aihot/contracts/research";
import { StarButton } from "../feed/parts";
import { markRead, useReadSet } from "../../lib/local-state";
const date = (value: string | null) => value ? new Date(value).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Shanghai" }) : "发表日期待确认";
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
export function ResearchRecord({ item, variant = "library", read = false, onOpen }: { item: FeedItemSummary; variant?: "library" | "editorial"; read?: boolean; onOpen?: (id: string) => void }) {
  const r = item.research;
  const form = DOCUMENT_TYPES.find(v => v.key === r?.documentType)?.label;
  const journal = r?.bibliography.journal || item.source.name;
  return <article className={`research-record ${variant} ${read ? "is-read" : ""}`} data-item-id={item.id}>
    <div className="record-meta"><span>{form || "研究资料"}</span><span className="record-journal">{journal}</span><time dateTime={r?.bibliography.publishedDate || item.publishedAt || undefined}>{date(r?.bibliography.publishedDate || item.publishedAt)}</time></div>
    <div className="record-title-row"><h3><Link to={`/items/${item.id}`} onClick={() => onOpen?.(item.id)}>{item.title}</Link></h3><StarButton item={item} size={44} /></div>
    {item.summary && r?.status === "ready" && <p className="record-summary">{item.summary}</p>}
    {r?.status === "pending" && <p className="record-summary text-ink-3">研究导读待整理，可先查看文献索引与原文。</p>}
    <ResearchTags item={item} />
    <div className="record-basis"><span className={r?.status === "insufficient" ? "material-warning" : ""}>{r ? BASIS_LABELS[r.basis] : "材料范围待整理"}</span>{item.selected && <span className="selected-label">编辑精选</span>}{r?.bibliography.doi && <span className="mono record-doi">DOI {r.bibliography.doi}</span>}</div>
    {variant === "editorial" && item.reason && r?.status === "ready" && <p className="record-reason"><span>阅读意义</span>{item.reason}</p>}
  </article>;
}
export function ResearchList({ items, variant = "library" }: { items: FeedItemSummary[]; variant?: "library" | "editorial" }) {
  const read = useReadSet();
  return <div className="research-list">{items.map(item => <ResearchRecord key={item.id} item={item} variant={variant} read={read.has(item.id)} onOpen={markRead} />)}</div>;
}
