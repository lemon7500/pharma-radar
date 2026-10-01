import { Link, useSearchParams } from "react-router";
import { FACET_GROUPS, parseResearchFilters } from "@aihot/contracts/research";
import { CATEGORY_LABELS, isCategoryKey, CHANNEL_LABELS, isChannelKey } from "@aihot/contracts/taxonomy";
import { hrefWith } from "../feed/Filters";
import { useEffect, useRef } from "react";
export function FacetFilters({ base = "/all" }: { base?: string }) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  useEffect(() => { const media = window.matchMedia("(min-width: 961px)"); const change = () => { if (disclosure.current) disclosure.current.open = media.matches; }; change(); media.addEventListener("change",change); return () => media.removeEventListener("change",change); },[]);
  const [params] = useSearchParams();
  const f = parseResearchFilters(params);
  const toggle = (param: keyof typeof f, key: string) => {
    const values: string[] = [...(f[param] || [])];
    const next = values.includes(key) ? values.filter(v => v !== key) : [...values, key];
    return hrefWith(base, params, { [param]: next.join(",") || null });
  };
  const active: Array<{ label: string; to: string }> = FACET_GROUPS.flatMap(g => (f[g.param] || []).map(k => ({ label: g.values.find(v => v.key === k)?.label || k, to: toggle(g.param, k) })));
  const category = params.get("category"), channel = params.get("channel"), tag = params.get("tag"), topic = params.get("topic");
  if (category && isCategoryKey(category)) active.push({ label: `原分类：${CATEGORY_LABELS[category]}`, to: hrefWith(base, params, { category: null }) });
  if (channel && isChannelKey(channel) && channel !== "all") active.push({ label: `来源筛选：${CHANNEL_LABELS[channel]}`, to: hrefWith(base, params, { channel: null }) });
  if (tag) active.push({ label: `关键词：${tag}`, to: hrefWith(base, params, { tag: null }) });
  if (topic) active.push({ label: `专题：${topic}`, to: hrefWith(base, params, { topic: null }) });
  const clear = hrefWith(base, params, Object.fromEntries([...FACET_GROUPS.map(g => g.param), "category", "channel", "tag", "topic"].map(p => [p, null])));
  return <section aria-label="组合筛选" className="facets">
    <details ref={disclosure} className="facet-disclosure"><summary><span>组合筛选</span><span className="text-ink-3">{active.length ? `${active.length} 个条件` : "研究环节 · 专题 · 证据"}</span><span aria-hidden="true">＋</span></summary>
      <div className="facet-groups">{FACET_GROUPS.map(g => <div className="facet-group" key={g.param}><h3>{g.label}</h3><div>{g.values.map(v => <Link key={v.key} to={toggle(g.param, v.key)} className={(f[g.param] as string[] | undefined)?.includes(v.key) ? "facet-option selected" : "facet-option"} aria-label={`${(f[g.param] as string[] | undefined)?.includes(v.key) ? "移除" : "添加"}${g.label}筛选：${v.label}`}><span aria-hidden="true">{(f[g.param] as string[] | undefined)?.includes(v.key) ? "✓" : "＋"}</span>{v.label}</Link>)}</div></div>)}</div>
    </details>
    {!!active.length && <div className="active-facets" aria-label="已选条件">{active.map((v,i) => <Link key={i} to={v.to} aria-label={`移除筛选：${v.label}`}>{v.label}<span aria-hidden="true">×</span></Link>)}<Link to={clear} className="clear-facets">清除筛选</Link></div>}
  </section>;
}
