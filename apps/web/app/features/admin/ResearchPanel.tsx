import { useState } from "react";
import type { Bibliography, ResearchProfile } from "@aihot/contracts/research";
import { FACET_GROUPS, BASIS_LABELS, RESEARCH_CLAIMS } from "@aihot/contracts/research";
import { useAdminAction } from "./action";
import { Badge, Button, Card, Field, Input, Json, ReasonDialog, Textarea } from "./ui";
type Row = Record<string,any>;
const emptyBibliography:Bibliography = {doi:null,pmid:null,authors:[],journal:null,publishedDate:null,publicationTypes:[],isPreprint:null};
function paired(profile:ResearchProfile|null, support:Record<string,string>) {
  if (!profile) return {areas:[],foci:[],evidenceStages:[],documentType:null,origin:null,clinicalPhase:null,claims:{}};
  const entry = (key:string,value:string|null) => value && support[key] ? {value,quote:support[key]} : null;
  return {
    areas:profile.areas.map(v => entry(`areas.${v}`,v)).filter(Boolean), foci:profile.foci.map(v => entry(`foci.${v}`,v)).filter(Boolean),
    evidenceStages:profile.evidenceStages.map(v => entry(`evidenceStages.${v}`,v)).filter(Boolean),
    documentType:entry("documentType",profile.documentType), origin:entry("origin",profile.origin),clinicalPhase:entry("clinicalPhase",profile.clinicalPhase),
    claims:Object.fromEntries(RESEARCH_CLAIMS.map(c => [c.key, profile.claims[c.key] && support[`claims.${c.key}`] ? {text:profile.claims[c.key],quote:support[`claims.${c.key}`]} : null])),
  };
}
export function AdminResearchPanel({ article,publication,override,base }: {article:Row;publication:Row|null;override:Row|null;base:string}) {
  const profile:ResearchProfile|null = publication?.research || article.research_profile || null;
  const support = override?.fields?.researchSupport || article.research_support || {};
  const {run,pending} = useAdminAction(); const [open,setOpen] = useState(false); const [retry,setRetry] = useState(false);
  const [metadata,setMetadata] = useState<Bibliography>(profile?.bibliography || article.bibliography || emptyBibliography);
  const [structure,setStructure] = useState(""); const [error,setError] = useState("");
  const edit = () => { setMetadata(profile?.bibliography || article.bibliography || emptyBibliography);setStructure(JSON.stringify(paired(profile,support),null,2));setError("");setOpen(true); };
  return <div className="mb-5"><Card title="文献与研究结构" right={<div className="flex gap-2"><Button size="sm" onClick={edit}>修正文献与导读</Button><Button size="sm" onClick={() => setRetry(true)}>重试研究整理</Button></div>}>
    <div className="mb-3 flex flex-wrap gap-2"><Badge>{profile ? BASIS_LABELS[profile.basis] : "待整理"}</Badge><Badge>{profile?.status === "ready" ? "导读已整理" : profile?.status === "insufficient" ? "材料不足，暂停深入导读" : "研究结构待整理"}</Badge>{article.research_retry_at && <Badge tone="warn">等待重试</Badge>}{article.canonical_article_id && <Badge>重复 DOI · 保留旧入口</Badge>}</div>
    <Json value={profile} label="公开研究结构" /><Json value={support} label="来源依据（仅后台）" />
    <details className="mt-3 text-[12px]"><summary className="cursor-pointer py-2 text-accent">查看已获取材料</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-control bg-bg-sunk p-3 leading-relaxed">{article.title}{"\n\n"}{article.research_material || "没有获取摘要或正文"}</pre></details>
    <p className="mt-3 text-[12px] leading-relaxed text-ink-3">元数据请核对来源原文；研究阶段与结论必须附已获取材料中的逐字片段。人工修正记录原因、版本和来源依据，重新评估不会覆盖。</p>
  </Card>
  <ReasonDialog open={open} title="修正文献与研究导读" description="文献元数据来自原文核对。下方研究结构使用 value／quote 或 text／quote 配对，quote 必须出现在上方已获取材料中；没有依据的字段留空。" confirmLabel="验证并发布" busy={pending === "research-edit"} onClose={() => setOpen(false)} onSubmit={async reason => {
    try {
      const parsed = JSON.parse(structure);setError("");
      return (await run("POST",`${base}/override`,{fields:{research:parsed,researchBibliography:metadata},version:override?.version || 0,reason},{label:"research-edit",success:"文献与研究结构已验证、审计并重新发布"})) !== null;
    } catch {setError("研究结构 JSON 格式无效，请检查引号与逗号。");return false;}
  }}>
    <Field label="DOI"><Input value={metadata.doi || ""} onChange={e => setMetadata({...metadata,doi:e.target.value.trim().toLowerCase() || null})} /></Field>
    <Field label="PMID"><Input value={metadata.pmid || ""} onChange={e => setMetadata({...metadata,pmid:e.target.value.trim() || null})} /></Field>
    <Field label="作者（每行一位，保持来源顺序）"><Textarea rows={3} value={metadata.authors.join("\n")} onChange={e => setMetadata({...metadata,authors:e.target.value.split("\n").map(v=>v.trim()).filter(Boolean)})} /></Field>
    <Field label="期刊"><Input value={metadata.journal || ""} onChange={e => setMetadata({...metadata,journal:e.target.value || null})} /></Field>
    <Field label="发表日期"><Input type="date" value={metadata.publishedDate || ""} onChange={e => setMetadata({...metadata,publishedDate:e.target.value || null})} /></Field>
    <div className="rounded-control bg-bg-sunk p-3 text-[11px] leading-relaxed text-ink-3">{FACET_GROUPS.map(g => <p key={g.param}>{g.label}：{g.values.map(v => `${v.key}（${v.label}）`).join("；")}</p>)}<p>研究字段：areas、foci、documentType、evidenceStages、origin、clinicalPhase；claims 包含 object、question、methods、results、limitations。</p></div>
    <Field label="研究结构与来源依据 JSON"><Textarea rows={14} className="font-mono text-[12px]" value={structure} onChange={e => setStructure(e.target.value)} /></Field>{error && <p role="alert" className="text-hot">{error}</p>}
  </ReasonDialog>
  <ReasonDialog open={retry} title="重试研究整理" description="由下次定时批处理执行，继续受每日最多 20 篇旧稿及当前模型调用预算限制。材料不足时保留索引，正常采集与阅读不受影响。" busy={pending === "research-retry"} onClose={() => setRetry(false)} confirmLabel="安排重试" requireReason={false} onSubmit={async () => (await run("POST",`${base}/rerun`,{step:"research"},{label:"research-retry",success:"已安排下一次研究整理"})) !== null} />
  </div>;
}
