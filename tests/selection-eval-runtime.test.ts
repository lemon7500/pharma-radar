import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";
import { REPO_ROOT } from "@aihot/backend/config";
import { buildScoreInput } from "@aihot/backend/editorial/analyze";
import { loadAnalyzeInput } from "@aihot/backend/editorial/input";
import { sourcePublicationTime } from "@aihot/backend/editorial/publication-time";
import { upsertMaterial } from "@aihot/backend/content/materials";
import type { Bibliography } from "@aihot/contracts/research";

const exec = promisify(execFile);

interface GoldRow {
  caseId: string;
  material: { title: string; originalTitle: null; publishedAt: string | null; publishedAtSource?: string | null; bibliography?: Bibliography | null; sourceName: string; bodyZh: null; bodyOriginal: string };
  sourceFacts: { sourceKind: "rss"; sourceTier: string; firstParty: boolean; language: "en" };
  samplingContext?: { benchmarkSplit?: string; samplingStratum?: string };
  gold: { decision: "select" | "reject" };
}

const row = (caseId: string, marker: string, tier: string, decision: "select" | "reject", split?: string): GoldRow => ({
  caseId,
  material: {
    title: `${marker} model release`,
    originalTitle: null,
    publishedAt: "2026-09-30T09:00:00+08:00",
    sourceName: `Source ${caseId}`,
    bodyZh: null,
    bodyOriginal: `${marker} released a model with benchmark, pricing and availability details. `.repeat(8),
  },
  sourceFacts: { sourceKind: "rss", sourceTier: tier, firstParty: tier === "T1", language: "en" },
  ...(split ? { samplingContext: { benchmarkSplit: split, samplingStratum: tier } } : {}),
  gold: { decision },
});

interface Result {
  meta: { split: string; promptVersion: string };
  model: string;
  reportPath: string;
  summary: { decisive: number; errors: number; accuracy: number; tokensIn: number; tokensOut: number };
  cases: Array<{ caseId: string; decision: string | null; error: string | null }>;
}

async function evaluate(rows: GoldRow[], providers: { prefilter: string; score: string }, opts: { split?: string } = {}): Promise<Result> {
  const dir = mkdtempSync(path.join(tmpdir(), "selection-eval-"));
  let reportPath: string | undefined;
  try {
    const gold = path.join(dir, "gold.jsonl");
    writeFileSync(gold, rows.map((item) => JSON.stringify(item)).join("\n"));
    const args = ["scripts/eval-selection.ts", "--gold", gold, "--concurrency", "6", "--no-import"];
    if (opts.split) args.push("--split", opts.split);
    const { stdout } = await exec(process.execPath, args, {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        MODEL_CALLS_ENABLED: "true",
        SCORE_MODEL: "glm-5.3-flash-selection",
        PREFILTER_MODEL: "qwen3.7-flash",
        DASHSCOPE_BASE_URL: `${providers.prefilter}/v1`,
        DASHSCOPE_API_KEY: "test-key",
        ZHIPU_BASE_URL: `${providers.score}/v1`,
        ZHIPU_API_KEY: "test-key",
      },
      timeout: 20_000,
    });
    reportPath = stdout.split("\n").find((line) => line.startsWith("report: "))?.slice(8);
    assert.ok(reportPath, stdout);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      meta: { split: string; promptVersion: string };
      models: Record<string, { summary: Result["summary"]; cases: Result["cases"] }>;
    };
    const model = Object.keys(report.models)[0]!;
    return { meta: report.meta, model, reportPath, summary: report.models[model]!.summary, cases: report.models[model]!.cases };
  } finally {
    if (reportPath) rmSync(reportPath, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withoutModelOverrides<T>(run: () => Promise<T>): Promise<T> {
  const saved = await sql<{ key: string; value: unknown; updated_by: string | null; updated_at: Date }[]>`
    SELECT key, value, updated_by, updated_at FROM settings WHERE key IN ('models.score', 'models.prefilter')`;
  await sql`DELETE FROM settings WHERE key IN ('models.score', 'models.prefilter')`;
  try {
    return await run();
  } finally {
    await sql`DELETE FROM settings WHERE key IN ('models.score', 'models.prefilter')`;
    for (const row of saved) {
      await sql`
        INSERT INTO settings (key, value, updated_by, updated_at)
        VALUES (${row.key}, ${sql.json(row.value as never)}, ${row.updated_by}, ${row.updated_at})`;
    }
  }
}

after(async () => {
  await closeDb();
});

test("default evaluation follows the production score route and shares duplicate score inputs without changing tier decisions", async (t) => {
  await withoutModelOverrides(async () => {
    const prefilter = await stub(() => ({
      choices: [{ message: { content: JSON.stringify({ label: "PASS", reason: "relevant" }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));
    const score = await stub(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        choices: [{ message: { content: JSON.stringify({ attentionScore: 70 }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      };
    });
    t.after(async () => { await Promise.all([prefilter.close(), score.close()]); });

    const marker = tag();
    const rows = [row(`${marker}-t1`, marker, "T1", "select"), row(`${marker}-t2`, marker, "T2", "reject")];
    const cold = await evaluate(rows, { prefilter: prefilter.url, score: score.url });
    const warm = await evaluate(rows, { prefilter: prefilter.url, score: score.url });

    assert.equal(cold.model, "glm-5.3-flash-selection", "no --models follows SCORE_MODEL / production routing");
    assert.deepEqual(cold.summary, warm.summary, "cold and cached evaluations keep the same coverage and metrics");
    assert.deepEqual(cold.cases.map((item) => item.decision), ["select", "reject"], "the shared score still uses each tier's threshold");
    assert.deepEqual([cold.summary.decisive, cold.summary.errors, cold.summary.accuracy], [2, 0, 1]);
    assert.deepEqual([prefilter.hits(), score.hits()], [2, 2], "two per-case prefilters, two shared score calls across both runs");
    assert.deepEqual([cold.summary.tokensIn, cold.summary.tokensOut], [220, 50], "shared score receipts count once");
  });
});

test("a shared unusable score fails every matching case once, then retry usage includes every provider attempt", async (t) => {
  await withoutModelOverrides(async () => {
    const prefilter = await stub(() => ({
      choices: [{ message: { content: JSON.stringify({ label: "PASS", reason: "relevant" }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));
    const score = await stub((hit) => ({
      choices: [{ message: { content: hit === 1 ? "not JSON" : JSON.stringify({ attentionScore: 70 }) } }],
      usage: { prompt_tokens: hit === 1 ? 100 : 300, completion_tokens: 20 },
    }));
    t.after(async () => { await Promise.all([prefilter.close(), score.close()]); });

    const marker = tag();
    const rows = [row(`${marker}-t1`, marker, "T1", "select"), row(`${marker}-t2`, marker, "T2", "reject")];
    const failed = await evaluate(rows, { prefilter: prefilter.url, score: score.url });
    assert.deepEqual([failed.summary.decisive, failed.summary.errors], [0, 2]);
    assert.equal(score.hits(), 1, "matching cases share the failed score result within one run");
    assert.equal(failed.summary.tokensIn, 120, "both prefilters plus the unusable paid score are accounted");

    const retried = await evaluate(rows, { prefilter: prefilter.url, score: score.url });
    assert.deepEqual([retried.summary.decisive, retried.summary.errors, retried.summary.accuracy], [2, 0, 1]);
    assert.equal(score.hits(), 3, "the next run retries once, then performs score-2 once");
    assert.deepEqual([retried.summary.tokensIn, retried.summary.tokensOut], [720, 70], "usage includes the unusable attempt and both successful retries");
  });
});

test("custom split names cannot escape the evaluation output directory", async (t) => {
  await withoutModelOverrides(async () => {
    const prefilter = await stub(() => ({
      choices: [{ message: { content: JSON.stringify({ label: "BLOCK", reason: "irrelevant" }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));
    const score = await stub(() => {
      throw new Error("score should not run for blocked input");
    });
    t.after(async () => { await Promise.all([prefilter.close(), score.close()]); });

    const marker = tag();
    const split = "../../../../outside";
    const result = await evaluate([row(`${marker}-blocked`, marker, "T1", "reject", split)], { prefilter: prefilter.url, score: score.url }, { split });
    assert.equal(path.dirname(result.reportPath), path.join(REPO_ROOT, ".data/eval"));
    assert.ok(path.basename(result.reportPath).startsWith("selection-outside-1-"));
    assert.equal(result.meta.split, split, "metadata keeps the original user-supplied split");
    assert.equal(score.hits(), 0);
  });
});

test("evaluation and production preserve the same date-only, exact and unknown source date inputs", async (t) => {
  await withoutModelOverrides(async () => {
    const prefilter = await stub(() => ({ choices: [{ message: { content: JSON.stringify({label:"PASS",reason:"relevant"}) } }] }));
    const scoreInputs: string[] = [];
    const score = await stub((_hit, req) => {
      const body = JSON.parse(req.body) as {messages:Array<{content:string}>};
      scoreInputs.push(body.messages.at(-1)!.content);
      return {choices:[{message:{content:JSON.stringify({attentionScore:70})}}]};
    });
    t.after(async () => { await Promise.all([prefilter.close(),score.close()]); });
    const marker = tag(), sourceId = `eval-clock-${marker}`;
    await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES(${sourceId},'Date precision test','rss','T1_5','editorial')`;
    const dates = [{publishedAt:"2026-10-01"},{publishedAt:"2026-10-01T00:00:00Z",publishedAtSource:"2026-10-01T00:00:00Z"},{publishedAt:null},{publishedAt:"2026-10-01T00:00:00.000Z"},{publishedAt:"2026-10-01T01:35:00Z",publishedAtSource:"2026-10-01T01:35:00Z",bibliography:{doi:null,pmid:null,authors:[],journal:"Test Journal",publishedDate:"2020-01-02",publicationTypes:[],isPreprint:false}}];
    const rows: GoldRow[] = dates.map((date,i) => {
      const item = row(`${marker}-${i}`,`${marker}-case-${i}`,"T1_5","select");
      return {...item,material:{...item.material,...date}};
    });
    const productionInputs: string[] = [];
    for (const [i,item] of rows.entries()) {
      const at = item.material.publishedAt ? new Date(item.material.publishedAt) : null;
      const sourceValue = item.material.publishedAtSource ?? (/^\d{4}-\d{2}-\d{2}$/.test(item.material.publishedAt ?? "") ? item.material.publishedAt : null);
      const {articleId} = await upsertMaterial({sourceId,url:`https://example.org/${marker}/${i}`,title:item.material.title,bodyText:item.material.bodyOriginal,publishedAt:at,bibliography:item.material.bibliography,via:"fetch",raw:{publicationTime:sourcePublicationTime(sourceValue,at)}});
      productionInputs.push(buildScoreInput((await loadAnalyzeInput(articleId))!));
    }
    const result = await evaluate(rows,{prefilter:prefilter.url,score:score.url});
    assert.equal(result.summary.errors,0);
    assert.equal(scoreInputs.length,10);
    for (const input of productionInputs) assert.equal(scoreInputs.filter(value=>value===input).length,2,"each source precision reaches both evaluations without a different production representation");
    assert.match(productionInputs[0]!,/】\n2026-10-01\n\n/);
    assert.match(productionInputs[1]!,/2026-10-01T08:00:00\+08:00/);
    assert.match(productionInputs[2]!,/】\n待确认\n\n/);
    assert.match(productionInputs[3]!,/】\n2026-10-01\n\n/,"a normalized legacy midnight timestamp is not proof of a real source clock");
    assert.match(productionInputs[4]!,/】\n2020-01-02\n\n/,"a newer RSS timestamp cannot erase a verified older bibliographic publication date");
  });
});
