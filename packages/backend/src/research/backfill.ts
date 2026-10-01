import { z } from "zod";
import { sql } from "../db.ts";
import { loadAnalyzeInput, buildMaterial } from "../editorial/input.ts";
import { modelFor } from "../editorial/models.ts";
import { promptText, promptVersion } from "../editorial/prompts.ts";
import { chatJson } from "../providers/llm.ts";
import { completeReceipt } from "../providers/receipts.ts";
import { BudgetExceededError } from "../providers/receipts.ts";
import { audit } from "../admin/auth.ts";
import { publishArticle } from "../publication/publish.ts";
import { baselineResearch, validateResearchExtraction } from "./profile.ts";
import { enrichResearchMaterial, reconcileResearchDoi } from "./enrich.ts";

export async function backfillResearch(options: { limit?: number; deadline?: number } = {}) {
  if (process.env.RESEARCH_BACKFILL_ENABLED !== "true" || process.env.MODEL_CALLS_ENABLED !== "true" || await researchBackfillPaused()) return { processed: 0, failed: 0, disabled: true };
  const [storage] = await sql<{bytes:number}[]>`SELECT pg_database_size(current_database()) AS bytes`;
  if (researchPauseReason(Number(storage!.bytes),0)) {
    await pauseResearchBackfill("数据库接近免费容量上限（400 MB），已自动暂停旧稿整理");
    return {processed:0,failed:0,disabled:true};
  }
  const [used] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM articles WHERE research_backfill_attempted_at >= now() - interval '24 hours'`;
  const limit = Math.max(0, Math.min(options.limit ?? 20, 20 - used!.n));
  const rows = await sql<{ id: string }[]>`SELECT a.id FROM articles a JOIN publications p ON p.article_id = a.id
    WHERE p.visibility = 'public' AND p.eligible AND a.canonical_article_id IS NULL
    AND (a.research_enriched_at IS NULL OR a.research_revision IS DISTINCT FROM a.revision)
    AND (a.research_backfill_attempted_at IS NULL OR a.research_backfill_attempted_at < now() - interval '24 hours')
    AND (a.research_retry_at IS NULL OR a.research_retry_at <= now())
    ORDER BY a.discovered_at DESC, a.id LIMIT ${limit}`;
  let processed = 0, failed = 0, consecutiveFailures = 0;
  for (const row of rows) {
    if (await researchBackfillPaused()) break;
    if (options.deadline && Date.now() > options.deadline - 150_000) break;
    if (!await claimResearchBackfill(row.id)) continue;
    try {
      await enrichResearchMaterial(row.id);
      const input = await loadAnalyzeInput(row.id);
      if (!input) continue;
      let profile = baselineResearch(input), support = {}, receiptId: number | null = null;
      if (profile.status !== "insufficient" && process.env.MODEL_CALLS_ENABLED === "true") {
        const res = await chatJson({ model: await modelFor("structure"), purpose: "research_backfill", subject: `article:${row.id}@${input.revision}`,
          promptVersion: promptVersion("research-profile"), system: `${promptText("safety")}\n${promptText("rules-pharma")}\n${promptText("research-profile")}\n只返回 JSON 对象 {"research":研究结构对象}。`,
          user: buildMaterial(input), schema: z.object({ research: z.object({ areas:z.array(z.unknown()).max(8),foci:z.array(z.unknown()).max(8),evidenceStages:z.array(z.unknown()).max(8),claims:z.record(z.string(),z.unknown()) }).passthrough() }), temperature: 0.1, maxTokens: 3600,
        });
        ({ profile, support } = validateResearchExtraction(res.data.research, input));
        receiptId = res.receiptId;
      }
      await sql.begin(async tx => {
        const stored = await tx`UPDATE articles SET research_profile = ${tx.json(profile as never)}, research_support = ${tx.json(support)},
          research_revision = ${input.revision}, research_enriched_at = now(), research_retry_at = NULL
          WHERE id = ${row.id} AND revision = ${input.revision} RETURNING id`;
        if (!stored.count) throw new Error("research material changed");
        if (receiptId !== null) await completeReceipt(tx, receiptId);
      });
      const aliases = await reconcileResearchDoi(row.id);
      for (const id of new Set([row.id, ...aliases])) await publishArticle(id);
      processed++;
      consecutiveFailures = 0;
    } catch (error) {
      // Keep the published paper readable. Provider details/URLs stay in private receipts.
      await sql`UPDATE articles SET research_retry_at = now() + interval '24 hours' WHERE id = ${row.id}`;
      // Trusted bibliography fetched before a model failure is still useful to readers.
      await publishArticle(row.id);
      failed++;
      if (error instanceof BudgetExceededError) break;
      consecutiveFailures++;
      if (researchPauseReason(0,consecutiveFailures)) {
        await pauseResearchBackfill("研究整理连续失败 3 次，已自动暂停旧稿整理；请核对任务和模型服务");
        break;
      }
    }
  }
  return { processed, failed, remainingDailyCapacity: Math.max(0, limit - processed - failed) };
}

export function researchPauseReason(databaseBytes:number, consecutiveFailures:number) {
  return databaseBytes >= 400_000_000 || consecutiveFailures >= 3;
}
async function pauseResearchBackfill(reason:string) {
  await sql`INSERT INTO settings(key,value) VALUES('research.backfill.paused',${sql.json({paused:true,reason})})
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`;
  await audit('research.backfill','research.backfill.pause','research.backfill',reason,{paused:false},{paused:true});
}

export async function researchBackfillPaused() {
  const [row] = await sql<{ value:{ paused?:boolean } }[]>`SELECT value FROM settings WHERE key='research.backfill.paused'`;
  return row?.value.paused === true;
}

/** Serialize the rolling daily cap across simultaneous batch/admin retries. */
export async function claimResearchBackfill(id: string): Promise<boolean> {
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('research_backfill_daily'))`;
    const [used] = await tx<{ n:number }[]>`SELECT count(*)::int AS n FROM articles WHERE research_backfill_attempted_at >= now() - interval '24 hours'`;
    if (used!.n >= 20) return false;
    const claimed = await tx`UPDATE articles SET research_backfill_attempted_at = now()
      WHERE id = ${id} AND (research_backfill_attempted_at IS NULL OR research_backfill_attempted_at < now() - interval '24 hours') RETURNING id`;
    return claimed.count > 0;
  });
}
/** Free baseline projection for legacy items before their gradual model enrichment. */
export async function publishResearchBaseline() {
  const rows = await sql<{ article_id:string }[]>`SELECT article_id FROM publications WHERE research IS NULL`;
  for (const row of rows) await publishArticle(row.article_id);
  return rows.length;
}
