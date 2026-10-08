import { SITE } from "@aihot/industry/site";
import { useState } from "react";
import { Link, useFetcher } from "react-router";
import { useEffect } from "react";
import type { Route } from "./+types/runs";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { ago, bj, duration, num } from "../../features/admin/format";
import { AdminPage, Badge, Button, Card, DataTable, Dot, Empty, Field, Json, ReasonDialog, Select, Stat, Time } from "../../features/admin/ui";

type Row = Record<string, any>;
interface Runs {
  publicationLatency:{
    waiting:{count:number;recentCount:number;historicalOrUnknownCount:number;oldestDiscoveredAt:string|null;oldestWaitMinutes:number|null};
    firstPublic:{sampleCount:number;p50Minutes:number|null;p95Minutes:number|null};
    indexOnly:{count:number;recentCount:number;historicalOrUnknownCount:number;oldestFirstPublicAt:string|null;oldestAgeMinutes:number|null;untrackedCount:number};
  };
  deferredEvents:Array<{queue:string;reason:string;service:string|null;n:number;next:string;oldest:string}>;
  modelBudget:{available:boolean;blockedWindow:string|null;retryAt:string|null;remaining:{minute:number;hour:number;day:number}|null;
    blockedReason?:'budget'|'background-reserve'|null;
    reserve?:{reserved:{minute:number;hour:number;day:number};backgroundCaps:{minute:number;hour:number;day:number};remainingBackground:{minute:number;hour:number;day:number};blockedWindow:'hour'|'day'|null;retryAt:string|null;recentHours:number};
  };
  research:{rejected:number;rejectedFields:Array<{reason:string;count:number}>;processingVersion:string;total:number;ready:number;insufficient:number;waiting:number;retrying:number;attempted:number;database_bytes:string;requests:number;cost:string|null;paused:boolean;pauseReason:string|null};
  checkedAt: string;
  processes: Array<{ role: string; pid: number; host: string; release: string; startedAt: string; at: string; alive: boolean; mode?:string; status?:string }>;
  jobs: Row[];
  timeline: Row[];
  queues: Array<{ name: string; state: string; n: number; oldest: string }>;
  failedJobs: Row[];
  lagging: Row[];
  receipts: { counts: Record<string, number>; issues: Row[] };
  deliveries: Row[];
  errors: Row[];
  retrying: { count: number; next: string | null };
  ingest: Row[];
  leaderboard: { at: string; sources: Array<{ key: string; ok: boolean; at: string; lastOkAt: string | null; changed?: boolean; rows?: number; error?: string }> } | null;
}


export async function loader({ request }: Route.LoaderArgs) {
  return adminGet<Runs>(request, "/api/admin/runs");
}

export const meta: Route.MetaFunction = () => [{ title: `运行 · ${SITE.name} 后台` }];

const STATE_LABEL: Record<string, string> = { created: "排队", retry: "等待重试", active: "执行中" };

export default function RunsAdmin({ loaderData }: Route.ComponentProps) {
  const refresh = useFetcher<typeof loader>();
  const r = refresh.data ?? loaderData;
  const { run, pending } = useAdminAction();
  const [receipt, setReceipt] = useState<Row | null>(null);
  const [billed, setBilled] = useState("false");
  const [delivery, setDelivery] = useState<Row | null>(null);
  const [outcome, setOutcome] = useState<"sent" | "drop" | "resend">("sent");
  // Failure group to put back into processing ("" = every failure of the last 30 days).
  const [requeue, setRequeue] = useState<string | null>(null);
  const [researchPause,setResearchPause] = useState(false);

  // Live view: refresh every 20 s while visible.
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === "visible" && refresh.state === "idle" && refresh.load("/admin/runs"), 20_000);
    return () => clearInterval(t);
  }, [refresh]);

  const backlog = new Map<string, Record<string, { n: number; oldest: string }>>();
  for (const q of r.queues) backlog.set(q.name, { ...(backlog.get(q.name) ?? {}), [q.state]: { n: q.n, oldest: q.oldest } });
  const queued = r.queues.filter((q) => q.state !== "active").reduce((a, q) => a + q.n, 0);
  const worker = r.processes.find((p) => p.role === "worker");
  const batchState = worker?.mode === 'batch' ? worker.status : null;
  const workerTone = batchState === 'finished' ? 'muted' : batchState === 'failed' ? 'bad' : worker?.alive ? 'ok' : 'bad';
  const workerLabel = batchState === 'finished' ? '上轮已结束' : batchState === 'failed' ? '上轮运行失败' : worker ? (worker.alive ? '运行中' : '心跳中断') : '无心跳';
  const failing = r.jobs.filter((j) => j.status === "failed");

  return (
    <AdminPage title="运行" subtitle={<>任务、队列、信源延迟与需要人工核对的回执和投递。每 20 秒自动刷新 · 最近检查 {bj(r.checkedAt)}</>}>
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat
          label="worker"
          value={<span className="inline-flex items-center gap-2 text-[18px]"><Dot tone={workerTone} />{workerLabel}</span>}
          hint={worker ? `${worker.host} · ${batchState ? '上轮结束' : '心跳'} ${ago(worker.at)}` : "worker 未上报心跳"}
        />
        <Stat label="队列积压" value={num(queued)} tone={queued > 500 ? "warn" : undefined} hint="排队与等待重试" />
        <Stat label="失败的定时任务" value={num(failing.length)} tone={failing.length ? "bad" : "ok"} hint="最近一次运行失败" />
        <Stat label="回执结果未知" value={num(r.receipts.issues.filter((x) => x.status === "unknown").length)} tone={r.receipts.issues.some((x) => x.status === "unknown") ? "bad" : "ok"} hint={`7 天 ${num(Object.values(r.receipts.counts).reduce((a, b) => a + b, 0))} 次付费请求`} />
        <Stat label="投递待核实" value={num(r.deliveries.filter((d) => d.status === "unknown").length)} tone={r.deliveries.some((d) => d.status === "unknown") ? "bad" : "ok"} />
      </div>

      <div className="mb-5"><Card title="收录时效">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="等待检查或整理" value={num(r.publicationLatency.waiting.count)}
            hint={`近期发表 ${num(r.publicationLatency.waiting.recentCount)} · 历史或日期未知 ${num(r.publicationLatency.waiting.historicalOrUnknownCount)}`} />
          <Stat label="最老等待" value={r.publicationLatency.waiting.oldestWaitMinutes===null?'—':`${num(r.publicationLatency.waiting.oldestWaitMinutes,1)} 分钟`}
            hint={r.publicationLatency.waiting.oldestDiscoveredAt?`发现于 ${bj(r.publicationLatency.waiting.oldestDiscoveredAt,true)}`:'没有等待资料'} />
          <Stat label="首次公开中位耗时" value={r.publicationLatency.firstPublic.p50Minutes===null?'—':`${num(r.publicationLatency.firstPublic.p50Minutes,1)} 分钟`}
            hint={`最近 7 天新增可追踪记录 ${num(r.publicationLatency.firstPublic.sampleCount)} 条`} />
          <Stat label="首次公开 P95 耗时" value={r.publicationLatency.firstPublic.p95Minutes===null?'—':`${num(r.publicationLatency.firstPublic.p95Minutes,1)} 分钟`}
            hint="发现到首次公开，95% 样本不超过此值" />
        </div>
        <div className="mt-4 grid gap-3 border-t border-line pt-4 text-[13px] sm:grid-cols-2">
          <p>已公开待导读 <strong>{num(r.publicationLatency.indexOnly.count)}</strong> 条 <span className="text-ink-3">· 近期发表 {num(r.publicationLatency.indexOnly.recentCount)} · 历史或日期未知 {num(r.publicationLatency.indexOnly.historicalOrUnknownCount)}</span></p>
          <p>最老已公开待整理 <strong>{r.publicationLatency.indexOnly.oldestAgeMinutes===null?'—':`${num(r.publicationLatency.indexOnly.oldestAgeMinutes,1)} 分钟`}</strong>
            {r.publicationLatency.indexOnly.untrackedCount>0 && <span className="text-ink-3"> · {num(r.publicationLatency.indexOnly.untrackedCount)} 条旧稿未记录首次公开时间</span>}</p>
        </div>
        <p className="mt-4 text-[12px] leading-6 text-ink-3">等待资料尚需基本检查或整理，并不代表它们应当公开。近期发表指来源日期在过去 48 小时内，其余归为历史或日期未知。耗时仅从站内发现算到真实首次公开，样本仅含新增可追踪的公开记录；只有日期的发表记录不计算小时延迟，旧稿缺少首次公开记录时不补造时间。</p>
      </Card></div>

      <ReasonDialog open={researchPause} title={r.research.paused?'恢复渐进回填':'暂停渐进回填'} description="只改变旧稿研究整理的运行状态，正常采集与阅读继续运行；恢复后仍遵守每日 20 篇上限。" confirmLabel="应用" busy={pending==='research-pause'} onClose={()=>setResearchPause(false)} onSubmit={async reason=>(await run('POST','/api/admin/research/backfill',{paused:!r.research.paused,reason},{label:'research-pause',success:'回填状态已更新'}))!==null} />
      <div className="mb-5"><Card title="研究整理与资源用量" right={<Button size="sm" onClick={()=>setResearchPause(true)}>{r.research.paused?'恢复渐进回填':'暂停渐进回填'}</Button>}>
        {r.research.paused && <p className="mb-4 text-[13px] text-hot">已暂停：{r.research.pauseReason || '管理员暂停'}</p>}
        <div className="grid grid-cols-2 gap-4 text-[13px]"><p>导读已整理 <strong>{r.research.ready}</strong> / {r.research.total}</p><p>材料不足 <strong>{r.research.insufficient}</strong></p><p>未整理或版本待更新 <strong>{r.research.waiting}</strong></p><p>字段有拒收 <strong>{r.research.rejected}</strong></p><p>待重试 <strong>{r.research.retrying}</strong></p><p>24 小时旧稿 <strong>{r.research.attempted}</strong> / 20</p><p>数据库 <strong>{(Number(r.research.database_bytes)/1048576).toFixed(1)}</strong> MB</p><p>回填模型请求 <strong>{r.research.requests}</strong> 次</p><p>已记录费用 <strong>{r.research.cost === null ? "服务商未提供" : Number(r.research.cost).toFixed(4)}</strong></p></div><p className="mt-4 text-[12px] text-ink-3">处理版本：{r.research.processingVersion}。各项统计可重叠；“未整理或版本待更新”不包含周期性的来源复查，也不等于本轮可执行数量，重试仍受时间与每日上限限制。用量仅统计研究回填的实际请求，包含重试；模型用量及最终账单请在服务商核对。暂停后保留正常采集与阅读。</p><Json value={r.research.rejectedFields} label="字段拒收原因统计" />
      </Card></div>
      <div className="mb-5"><Card title="等待额度与回执的事件任务">
        <p className="mb-4 text-[13px] text-ink-3">新资料先处理，之后恢复事件摘要、简报和旧稿。额度按滚动时间窗口释放；这里的等待不计为模型失败，也不会提高调用上限。</p>
        {r.modelBudget.remaining && <p className="mb-4 text-[13px]">默认模型总剩余请求：每分钟 {r.modelBudget.remaining.minute} · 每小时 {r.modelBudget.remaining.hour} · 24 小时 {r.modelBudget.remaining.day}{!r.modelBudget.available && <> · {r.modelBudget.blockedWindow==='stopped'?'已停止调用':<>{r.modelBudget.blockedReason==='background-reserve'?'事件与旧稿等待预留额度释放，预计':'预计可恢复'} <Time at={r.modelBudget.retryAt} /></>}</>}</p>}
        {r.modelBudget.reserve && <div className="mb-4 rounded-lg border border-line p-3 text-[13px] leading-6">
          <p>近 {r.modelBudget.reserve.recentHours} 小时新资料预留：每小时 <strong>{num(r.modelBudget.reserve.reserved.hour)}</strong> · 24 小时 <strong>{num(r.modelBudget.reserve.reserved.day)}</strong> 次请求。</p>
          <p>事件与旧稿当前可用：每分钟 <strong>{num(r.modelBudget.reserve.remainingBackground.minute)}</strong> · 每小时 <strong>{num(r.modelBudget.reserve.remainingBackground.hour)}</strong> · 24 小时 <strong>{num(r.modelBudget.reserve.remainingBackground.day)}</strong> 次请求。</p>
          <p className="text-[12px] text-ink-3">预留包含在总额度内，不增加调用上限；已收到的结果可继续复用。</p>
        </div>}
        <DataTable dense rows={r.deferredEvents} rowKey={d=>`${d.queue}-${d.reason}-${d.service}`} empty="没有等待恢复的事件任务" columns={[
          {key:'queue',label:'任务',render:d=>d.queue==='events.digest'?'事件摘要':'资料归组'},
          {key:'reason',label:'等待原因',render:d=><Badge tone="warn">{d.reason==='budget'?'等待额度':'等待已有请求完成'}</Badge>},
          {key:'count',label:'数量',align:'right',render:d=>num(d.n)},
          {key:'next',label:'下次检查',render:d=><Time at={d.next} />},
        ]} />
        <p className="mt-3 text-[12px] text-ink-3">下次检查还需等待定时任务实际启动。已收到的结果会复用；结果未知的请求继续保留在下方供核对。</p>
      </Card></div>
      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="队列" pad={false}>
          <DataTable
            dense
            rows={[...backlog.entries()]}
            rowKey={([name]) => name}
            empty="队列是空的"
            columns={[
              { key: "n", label: "队列", render: ([name]) => <span className="font-mono text-[12.5px]">{name}</span> },
              ...(["created", "retry", "active"] as const).map((st) => ({
                key: st,
                label: STATE_LABEL[st],
                align: "right" as const,
                render: ([, v]: [string, Record<string, { n: number; oldest: string }>]) => (v[st] ? <span title={`最早 ${bj(v[st]!.oldest, true)}`}>{num(v[st]!.n)}</span> : <span className="text-ink-4">0</span>),
              })),
              { key: "old", label: "最早排队", render: ([, v]) => <Time at={v.created?.oldest ?? v.retry?.oldest ?? null} /> },
            ]}
          />
        </Card>
        <Card title="定时任务" pad={false}>
          <DataTable
            dense
            rows={r.jobs}
            rowKey={(j) => j.job}
            columns={[
              { key: "j", label: "任务", render: (j) => <span className="font-mono text-[12.5px]">{j.job}</span> },
              { key: "s", label: "上次", render: (j) => <Badge tone={j.waiting ? "warn" : j.status === "ok" ? "ok" : j.status === "failed" ? "bad" : "muted"} title={j.waiting ? (j.waiting_reason==='priority-work'?'等待新资料处理完成':'等待额度或已有请求') : j.error ?? undefined}>{j.waiting ? "等待恢复" : j.status ?? "运行中"}</Badge> },
              { key: "at", label: "时间", render: (j) => <Time at={j.started_at} /> },
              { key: "d", label: "耗时", align: "right", render: (j) => duration(j.started_at, j.finished_at) },
              { key: "f", label: "24h 失败", align: "right", render: (j) => (j.failed_24h ? <span className="text-hot">{j.failed_24h}/{j.runs_24h}</span> : `0/${j.runs_24h}`) },
            ]}
          />
        </Card>
      </div>

      {r.failedJobs.length > 0 && (
        <Card className="mt-5" title="24 小时内失败的队列任务" pad={false}>
          <DataTable
            dense
            rows={r.failedJobs}
            rowKey={(j) => j.name}
            columns={[
              { key: "n", label: "队列", render: (j) => <span className="font-mono text-[12.5px]">{j.name}</span> },
              { key: "c", label: "失败", align: "right", render: (j) => num(j.failed) },
              { key: "l", label: "最近", render: (j) => <Time at={j.last} /> },
              { key: "o", label: "最近错误", render: (j) => <span className="line-clamp-2 font-mono text-[11.5px] text-ink-3">{j.last_output}</span> },
            ]}
          />
        </Card>
      )}

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card title="需要核对的付费回执" right={<span>{Object.entries(r.receipts.counts).map(([k, v]) => `${k} ${v}`).join(" · ")}</span>} pad={false}>
          <DataTable
            dense
            rows={r.receipts.issues}
            rowKey={(x) => x.id}
            empty="没有待处理的回执"
            columns={[
              { key: "id", label: "回执", render: (x) => <span className="num">#{x.id}</span> },
              { key: "s", label: "状态", render: (x) => <Badge tone={x.status === "unknown" ? "bad" : "warn"}>{x.status}</Badge> },
              { key: "w", label: "服务", render: (x) => <span className="whitespace-nowrap">{x.service}{x.model ? ` · ${x.model}` : ""}</span> },
              { key: "p", label: "用途", render: (x) => (x.subject && /^[\w-]{10,}$/.test(x.subject) && x.purpose.includes("analy") ? <Link className="text-accent" to={`/admin/content/${x.subject}`}>{x.purpose}</Link> : x.purpose) },
              { key: "e", label: "错误", render: (x) => <span className="line-clamp-2 text-[12px] text-ink-3" title={x.error ?? ""}>{x.error}</span> },
              { key: "a", label: "", render: (x) => (x.status === "unknown" ? <Button size="sm" onClick={() => setReceipt(x)}>核对</Button> : null) },
            ]}
          />
        </Card>
        <Card title="需要核实的投递" pad={false}>
          <DataTable
            dense
            rows={r.deliveries}
            rowKey={(d) => d.id}
            empty="没有待核实的投递"
            columns={[
              { key: "t", label: "目标", render: (d) => d.target_key },
              { key: "s", label: "状态", render: (d) => <Badge tone={d.status === "unknown" ? "bad" : "warn"}>{d.status}</Badge> },
              { key: "sub", label: "内容", render: (d) => (d.subject_kind === "selected" ? <Link className="text-accent" to={`/admin/content/${d.subject_id}`}>{d.subject_id}</Link> : `${d.subject_kind} ${d.subject_id}`) },
              { key: "at", label: "时间", render: (d) => <Time at={d.updated_at} /> },
              { key: "a", label: "", render: (d) => <Button size="sm" onClick={() => setDelivery(d)}>处理</Button> },
            ]}
          />
        </Card>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card title="延迟或失败的信源" right={<Link className="text-accent" to="/admin/sources?health=failing">全部失败信源</Link>} pad={false}>
          <DataTable
            dense
            rows={r.lagging}
            rowKey={(s) => s.id}
            empty="信源都按时采集"
            columns={[
              { key: "n", label: "信源", render: (s) => <Link className="text-ink hover:text-accent" to={`/admin/sources/${encodeURIComponent(s.id)}`}>{s.name}</Link> },
              { key: "h", label: "健康", render: (s) => <Badge tone={s.health === "failing" ? "bad" : s.health === "degraded" ? "warn" : "muted"}>{s.health}</Badge> },
              { key: "ok", label: "上次成功", render: (s) => <Time at={s.last_ok_at} /> },
              { key: "nx", label: "应抓", render: (s) => <Time at={s.next_fetch_at} /> },
              { key: "e", label: "错误", render: (s) => <span className="line-clamp-1 text-[12px] text-ink-3" title={s.last_error ?? ""}>{s.last_error}</span> },
            ]}
          />
        </Card>
        <Card
          title="处理失败（30 天，按错误归类）"
          right={
            <span className="flex items-center gap-3">
              {r.retrying.count > 0 && <span>等待重试 {num(r.retrying.count)} 条 · 下一次 <Time at={r.retrying.next} /></span>}
              {r.errors.length > 0 && <Button size="sm" onClick={() => setRequeue("")}>全部重新处理</Button>}
            </span>
          }
          pad={false}
        >
          <DataTable
            dense
            rows={r.errors}
            rowKey={(e) => e.error}
            empty="没有处理失败"
            columns={[
              { key: "e", label: "错误", render: (e) => <span className="font-mono text-[11.5px] text-ink-2">{e.error}</span> },
              { key: "n", label: "条数", align: "right", render: (e) => num(e.n) },
              { key: "x", label: "示例", render: (e) => <Link className="text-accent" to={`/admin/content/${e.example}`}>查看</Link> },
              { key: "l", label: "最近", render: (e) => <Time at={e.last} /> },
              { key: "a", label: "", align: "right", render: (e) => <Button size="sm" onClick={() => setRequeue(e.error)}>重新处理</Button> },
            ]}
          />
        </Card>
      </div>

      {r.leaderboard && (
        <Card
          className="mt-5"
          title="模型榜评测来源"
          right={<span>最近抓取 {bj(r.leaderboard.at)} · 成功 {r.leaderboard.sources.filter((x) => x.ok).length}/{r.leaderboard.sources.length}</span>}
          pad={false}
        >
          <div className="max-h-[360px] overflow-y-auto">
            <DataTable
              dense
              rows={r.leaderboard.sources}
              rowKey={(x) => x.key}
              columns={[
                { key: "k", label: "来源", render: (x) => <span className="font-mono text-[12.5px]">{x.key}</span> },
                { key: "s", label: "上次抓取", render: (x) => <Badge tone={x.ok ? "ok" : "bad"}>{x.ok ? (x.changed ? "有更新" : "无变化") : "失败"}</Badge> },
                { key: "ok", label: "上次成功", render: (x) => <Time at={x.lastOkAt} /> },
                { key: "n", label: "行数", align: "right", render: (x) => (x.rows == null ? "—" : num(x.rows)) },
                { key: "e", label: "错误", render: (x) => <span className="line-clamp-1 text-[12px] text-ink-3" title={x.error ?? ""}>{x.error}</span> },
              ]}
            />
          </div>
        </Card>
      )}

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card title="任务时间线" pad={false}>
          <div className="max-h-[420px] overflow-y-auto">
            <DataTable
              dense
              rows={r.timeline}
              rowKey={(t) => t.id}
              columns={[
                { key: "at", label: "开始", render: (t) => <span className="num whitespace-nowrap">{bj(t.started_at)}</span> },
                { key: "j", label: "任务", render: (t) => <span className="font-mono text-[12px]">{t.job}</span> },
                { key: "s", label: "结果", render: (t) => <Badge tone={t.waiting ? "warn" : t.status === "ok" ? "ok" : t.status === "failed" ? "bad" : "muted"} title={t.error ?? undefined}>{t.waiting ? "等待恢复" : t.status ?? "运行中"}</Badge> },
                { key: "d", label: "耗时", align: "right", render: (t) => duration(t.started_at, t.finished_at) },
              ]}
            />
          </div>
        </Card>
        <Card title="外部上报" pad={false}>
          {r.ingest.length ? (
            <DataTable
              dense
              rows={r.ingest}
              rowKey={(e) => `${e.client}-${e.created_at}`}
              columns={[
                { key: "at", label: "时间", render: (e) => <Time at={e.created_at} /> },
                { key: "c", label: "客户端", render: (e) => e.client },
                { key: "k", label: "类型", render: (e) => e.kind },
                { key: "s", label: "结果", render: (e) => <Badge tone={e.status === "ok" ? "ok" : e.status === "error" ? "bad" : "muted"} title={e.error ?? undefined}>{e.status}</Badge> },
                { key: "x", label: "摘要", render: (e) => <Json value={e.summary} label="摘要" /> },
              ]}
            />
          ) : (
            <Empty>还没有外部上报（公众号截图监控、采集脚本）</Empty>
          )}
        </Card>
      </div>

      {r.processes.length > 0 && (
        <Card className="mt-5" title="进程">
          <ul className="grid gap-2 text-[13px] sm:grid-cols-2 lg:grid-cols-3">
            {r.processes.map((p) => (
              <li key={p.role} className="flex items-center gap-2">
                <Dot tone={p.mode==='batch' && p.status==='finished' ? 'muted' : p.mode==='batch' && p.status==='failed' ? 'bad' : p.alive ? "ok" : "bad"} />
                <span className="font-medium">{p.role}</span>
                <span className="text-ink-3">{p.host} · pid {p.pid} · {p.release} · 启动于 {bj(p.startedAt)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <ReasonDialog
        open={!!receipt}
        title={`核对回执 #${receipt?.id ?? ""}`}
        description="结果未知的请求不会自动重发。先到供应商控制台确认这次请求有没有计费，再放行：放行后下一次处理会重新发起调用。"
        confirmLabel="记录并放行"
        busy={pending === "release"}
        onClose={() => setReceipt(null)}
        onSubmit={async (note) => (await run("POST", `/api/admin/receipts/${receipt!.id}/release`, { billed: billed === "true", note }, { label: "release", success: "已放行" })) !== null}
      >
        <Field label="供应商是否计费">
          <Select value={billed} onChange={(e) => setBilled(e.target.value)}>
            <option value="false">未计费（请求没有被接受）</option>
            <option value="true">已计费（结果没有取回）</option>
          </Select>
        </Field>
      </ReasonDialog>
      <ReasonDialog
        open={requeue !== null}
        title={requeue ? "重新处理这一类失败" : "重新处理全部失败"}
        description="这些文章会重新进入处理队列（正文、判断、发布）。模型调用会重新计费；供应商拒绝的内容可能再次失败。"
        confirmLabel="重新处理"
        busy={pending === "requeue"}
        onClose={() => setRequeue(null)}
        onSubmit={async (reason) => (await run("POST", "/api/admin/processing/requeue", { group: requeue || null, reason }, { label: "requeue", success: "已重新排队" })) !== null}
      />
      <ReasonDialog
        open={!!delivery}
        title="处理投递"
        description="先到对应飞书群确认有没有收到。确认没收到再重发；开发环境不会真的发出。"
        confirmLabel="确认"
        danger={outcome === "resend"}
        busy={pending === "delivery"}
        onClose={() => setDelivery(null)}
        onSubmit={async (note) => (await run("POST", `/api/admin/deliveries/${delivery!.id}/resolve`, { outcome, note }, { label: "delivery", success: "已处理" })) !== null}
      >
        <Field label="结果">
          <Select value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)}>
            <option value="sent">群里已收到，标记为已送达</option>
            <option value="drop">不再发送</option>
            <option value="resend">群里没有，重新发送</option>
          </Select>
        </Field>
      </ReasonDialog>
    </AdminPage>
  );
}
