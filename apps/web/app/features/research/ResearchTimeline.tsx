import { useEffect, useRef, useState } from "react";
import { Form, Link, useSearchParams } from "react-router";
import type { FeedItemSummary } from "@aihot/contracts/site";
import { beijingWeekday } from "@aihot/contracts/time";
import { publicationTime } from "@aihot/contracts/publication-time";
import { markRead, useReadSet } from "../../lib/local-state";
import { ResearchRecord } from "./ResearchRecord";

export function publicationGroups(items: FeedItemSummary[]) {
  const groups = new Map<string, FeedItemSummary[]>();
  for (const item of items) {
    const key = (item.publicationTime ?? publicationTime(item)).date || "unknown";
    groups.set(key, [...(groups.get(key) || []), item]);
  }
  return [...groups].map(([date, records]) => ({ date, records }));
}

export function ResearchTimeline({ items, editorial = false }: { items: FeedItemSummary[]; editorial?: boolean }) {
  const read = useReadSet();
  const [closed, setClosed] = useState<Set<string>>(new Set());
  return <div className="publication-timeline">{publicationGroups(items).map(({date, records}) => <section className="publication-day" id={`day-${date}`} key={date}>
    <header className="publication-day-heading"><h2>{date === "unknown" ? "发表时间待确认" : date.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$1年$2月$3日")}</h2><span>{date !== "unknown" && `${beijingWeekday(date).replace("星期", "周")} · `}{records.length} 条 · 本页</span><button type="button" aria-expanded={!closed.has(date)} aria-controls={`entries-${date}`} onClick={() => setClosed(prev => { const next = new Set(prev); next.has(date) ? next.delete(date) : next.add(date); return next; })}>{closed.has(date) ? "展开 ⌄" : "收起 ⌃"}</button></header>
    <div id={`entries-${date}`} hidden={closed.has(date)}>{records.map(item => {
      const time = item.publicationTime ?? publicationTime(item);
      return <div className="publication-slot" key={item.id} data-card-key={item.id}><div className="publication-clock"><time dateTime={time.date || undefined}>{time.date ? time.date.slice(5).replace("-", "/") : "待确认"}</time>{time.time && <small>{time.time}</small>}<small>{time.date ? "发表" : "发表时间"}</small></div><ResearchRecord item={item} variant={editorial ? "editorial" : "library"} read={read.has(item.id)} onOpen={markRead} timeline /></div>;
    })}</div>
  </section>)}</div>;
}

export function PublicationRange({ base = "/all" }: { base?: string }) {
  const [params] = useSearchParams();
  return <Form method="get" action={base} className="publication-range">
    {[...params].filter(([k]) => !["from", "to", "page", "cursor", "search"].includes(k)).map(([k,v]) => <input type="hidden" name={k} value={v} key={k} />)}
    <label>起始发表日期<input type="date" name="from" defaultValue={params.get("from") || ""} key={`from-${params.get("from")}`} /></label><label>截止发表日期<input type="date" name="to" defaultValue={params.get("to") || ""} key={`to-${params.get("to")}`} /></label><button type="submit">按日期检索</button>
    {(params.has("from") || params.has("to")) && <Link to={(() => { const sp = new URLSearchParams(params); sp.delete("from"); sp.delete("to"); sp.delete("page"); return base + (sp.size ? "?"+sp : ""); })()}>清除日期</Link>}
  </Form>;
}

export function PublicationNavigator({ items, base = "/" }: { items: FeedItemSummary[]; base?: string }) {
  const panel = useRef<HTMLDetailsElement>(null);
  useEffect(() => { const media = window.matchMedia("(min-width: 761px)"); const change = () => { if (panel.current) panel.current.open = media.matches; }; change(); media.addEventListener("change",change); return () => media.removeEventListener("change",change); },[]);
  const groups = publicationGroups(items);
  return <details className="publication-navigator" ref={panel}><summary>按发表日期浏览</summary><nav aria-label="本页发表日期">{groups.map(({date, records}) => <a href={`#day-${date}`} key={date}><span>{date === "unknown" ? "发表时间待确认" : date.replaceAll("-", "/")}</span><span>{records.length} 条</span></a>)}</nav><PublicationRange base={base} /><p>日期导航对应本页资料；更早的研究可通过分页或日期范围查找。准确时刻统一为 UTC+08:00。</p></details>;
}
