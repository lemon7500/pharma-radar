// Public scope and sync through the real api routes: a licence revocation or a withdrawal reaches
// every exit, reports stop quoting withdrawn items, the hot board drops a withdrawn item at once, item
// pages follow the site's rule, an early release keeps the selected ledger in order, a withdrawal
// waiting behind an unreleased item leaves new snapshots at once, and snapshots answer conditional requests.
import { MCP_TOOL_NAMES as MCP_NAMES } from "@aihot/contracts/mcp";
import { config } from "@aihot/backend/config";
import { CATEGORY_LABELS } from "@aihot/contracts/taxonomy";
import { BASIS_LABELS, DOCUMENT_TYPES, type ResearchProfile } from "@aihot/contracts/research";
import { beijingDate } from "@aihot/contracts/time";
import { ogEtag } from "../apps/api/src/og/render.ts";
import { posterEtag } from "../apps/api/src/og/poster.ts";
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { setVisibility } from "@aihot/backend/admin/content";
import { updateSource } from "@aihot/backend/admin/sources";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle, republishSource } from "@aihot/backend/publication/publish";
import { computeHotRanking } from "@aihot/backend/events/hot";
import { latestHotRanking } from "@aihot/backend/events/hot-read";
import { effectiveWatermark } from "@aihot/backend/publication/v1";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const SOURCE = `test-publication-${T}`;
const BODY = `FULLTEXT-${T} `.repeat(40);
const REPORT_KEY = `2099-12-${String(10 + Math.floor(Math.random() * 19))}`;
const app = await buildApp();

before(async () => {
  // An interrupted earlier run may have left entries behind the release gate, holding the watermark.
  await sql`UPDATE selected_ledger SET visible_at = now() WHERE visible_at > now()`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
            VALUES (${SOURCE}, 'Test publication', 'rss', 'T1', 'editorial', true, true, '2100-01-01')`;
});
after(async () => {
  await sql`DELETE FROM reports WHERE kind = 'daily' AND key = ${REPORT_KEY}`;
  await app.close();
  await stopBoss();
  await closeDb();
});

let n = 0;
/** A selected article with full text and a summary. */
async function article(sourceId = SOURCE): Promise<string> {
  n += 1;
  const { articleId } = await upsertMaterial({
    sourceId, url: `https://example.com/${T}-${n}`, title: `Test ${n}`, bodyText: BODY, bodyHtml: `<p>${BODY}</p>`, bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', 'ai-pharma', ${`标题${n}-${T}`}, ${`SUMMARY-${n}-${T}`}, '理由', 90, true)`;
  return articleId;
}

async function storyFor(id: string, role: "report" | "mention" = "report"): Promise<string> {
  const publicId = randomUUID();
  const [story] = await sql<{ id: number }[]>`
    INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${publicId}, ${`STORY-${T}`}, now(), now()) RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`
    INSERT INTO facts (public_id, story_id, title) VALUES (${`fact-${publicId}`}, ${story!.id}, ${`FACT-${T}`}) RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${id}, ${role})`;
  return publicId;
}

const released = () => ({ releasedAt: new Date(Date.now() - 60_000) });
async function get(url: string, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: "GET", url, headers });
  return { status: res.statusCode, body: res.body, etag: res.headers.etag as string | undefined };
}

test("site reading sends one language while exports retain both, including after withdrawal", async () => {
  const id = await article();
  await sql`UPDATE articles SET language = 'en', body_html = '<h2>Original heading</h2><p>Original full body</p>' WHERE id = ${id}`;
  await sql`INSERT INTO translations (article_id, revision, body_html, body_text, origin) VALUES (${id}, 1, '<h2>译文标题</h2><p>中文完整正文</p>', '中文完整正文', 'source')`;
  await publishArticle(id, released());
  const normal = JSON.parse((await get(`/api/site/items/${id}`)).body);
  const original = JSON.parse((await get(`/api/site/items/${id}/original`)).body);
  assert.equal(normal.bodyLanguage, 'zh');
  assert.equal(normal.hasTranslation, true);
  assert.equal(normal.body.original, null);
  assert.ok(normal.body.zh.includes('中文完整正文'));
  assert.equal(normal.outline[0].text, '译文标题');
  assert.equal(original.bodyLanguage, 'original');
  assert.equal(original.body.zh, null);
  assert.ok(original.body.original.includes('Original full body'));
  assert.equal(original.outline[0].text, 'Original heading');
  const md = (await get(`/items/${id}/markdown`)).body;
  assert.ok(md.includes('Original full body') && md.includes('中文完整正文'));
  await setVisibility(id, { visibility: 'withdrawn', reason: 'test', version: 0 }, 'test');
  assert.equal((await get(`/api/site/items/${id}/original`)).status, 404);
});

test("revoking a source's licence takes its articles off every exit", async () => {
  const id = await article();
  await publishArticle(id, released());
  const story = await storyFor(id);
  assert.equal((await get(`/api/site/items/${id}`)).status, 200);
  assert.equal((await get(`/api/site/stories/${story}`)).status, 200);
  assert.ok((await get("/feed/full.xml")).body.includes(`FULLTEXT-${T}`), "full feed carries the body before");
  assert.ok((await get("/api/v1/items?mode=selected")).body.includes(id), "v1 lists the item before");

  const [source] = await sql<{ updated_at: Date }[]>`SELECT updated_at FROM sources WHERE id = ${SOURCE}`;
  const patch = { participation_mode: "isolated", site_fulltext: false, syndicate_fulltext: false };
  await updateSource(SOURCE, { patch, version: source!.updated_at.toISOString(), reason: "test" }, "test");
  const [queued] = await sql<{ value: { status: string } }[]>`SELECT value FROM settings WHERE key = ${`republish.source:${SOURCE}`}`;
  assert.equal(queued?.value.status, "queued", "the admin change queues a background republish");

  const result = await republishSource(SOURCE); // what the queued job runs
  assert.ok(result.reduced >= 1);
  assert.equal((await get(`/api/site/items/${id}`)).status, 404);
  assert.equal((await get(`/items/${id}/markdown`)).status, 404);
  assert.equal((await get(`/api/site/stories/${story}`)).status, 404, "the story drops an isolated source's last report");
  assert.equal((await get(`/api/v1/stories/${story}`)).status, 404);
  assert.ok(!(await get("/feed/full.xml")).body.includes(`FULLTEXT-${T}`), "full feed drops the body");
  assert.ok(!(await get("/api/v1/items?mode=selected")).body.includes(id), "v1 drops the item");

  await sql`UPDATE sources SET participation_mode = 'editorial', site_fulltext = true, syndicate_fulltext = true WHERE id = ${SOURCE}`;
});

test("a withdrawn item leaves every report exit", async () => {
  const id = await article();
  await publishArticle(id, released());
  const content = {
    sections: [{ label: "模型", items: [{ itemId: id, title: `LEAD-${T}`, summary: `QUOTED-${T}`, sourceUrl: `https://example.com/original-${T}`, sourceName: "Test" }] }],
    flashes: [],
  };
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, origin)
            VALUES ('daily', ${REPORT_KEY}, now() - interval '1 day', now(), ${sql.json(content as never)}, now(), 'manual')
            ON CONFLICT (kind, key) DO UPDATE SET content = EXCLUDED.content`;
  assert.ok((await get(`/api/v1/dailies/${REPORT_KEY}`)).body.includes(`QUOTED-${T}`), "the report quotes the item before");

  await setVisibility(id, { visibility: "withdrawn", reason: "test", version: 0 }, "test");
  for (const url of [`/api/v1/dailies/${REPORT_KEY}`, `/api/site/reports/daily/${REPORT_KEY}`]) {
    const res = await get(url);
    assert.equal(res.status, 200, url);
    assert.ok(!res.body.includes(`QUOTED-${T}`) && !res.body.includes(`original-${T}`), `${url} still quotes the withdrawn item`);
  }
  for (const url of ["/api/v1/dailies"]) {
    const res = await get(url);
    assert.ok(res.body.includes(REPORT_KEY), `${url} lists the report`);
    assert.ok(!res.body.includes(`LEAD-${T}`), `${url} headlines the withdrawn title`);
  }
});

test("a withdrawal takes down only the stories citing it, including secondary memberships", async () => {
  const id = await article();
  await publishArticle(id, released());
  const stories = [await storyFor(id), await storyFor(id, "mention")];
  const other = await article();
  await publishArticle(other, released());
  const unrelated = await storyFor(other);
  for (const story of stories) {
    assert.ok((await get(`/api/site/stories/${story}`)).body.includes(id));
    assert.ok((await get(`/api/v1/stories/${story}`)).body.includes(id));
  }

  await setVisibility(id, { visibility: "withdrawn", reason: "test", version: 0 }, "test");
  for (const story of stories) {
    assert.equal((await get(`/api/site/stories/${story}`)).status, 404);
    assert.equal((await get(`/api/v1/stories/${story}`)).status, 404);
  }
  assert.equal((await get(`/api/site/stories/${unrelated}`)).status, 200);
});

test("a withdrawn item leaves the hot board and the hot APIs at once, not at the next ranking", async () => {
  const [story] = await sql<{ id: number }[]>`
    INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${`HOT-${T}`}, now() - interval '2 hours', now()) RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`fact-${T}`}, ${story!.id}, ${`HOT-${T}`}) RETURNING id`;
  for (const id of [await article(), await article()]) {
    await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${id}, 'report')`;
    await sql`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
              VALUES (${story!.id}, ${id}, ${`participant-${id}`}, ${SOURCE}, 'editorial', now() - interval '1 hour')`;
    await publishArticle(id, released());
  }
  await computeHotRanking();
  const rep = (await latestHotRanking())!.entries.find((e) => e.storyId === story!.id)?.representativeItemId;
  assert.ok(rep, "the story is on the board with a representative item");
  const exits = ["/api/v1/hot-topics", "/api/site/hot"];
  for (const url of exits) assert.ok((await get(url)).body.includes(rep!), `${url} shows the item before`);

  await setVisibility(rep!, { visibility: "withdrawn", reason: "test", version: 0 }, "test");
  for (const url of exits) assert.ok(!(await get(url)).body.includes(rep!), `${url} still shows the withdrawn item`);
});

test("item pages follow the live rule: unsummarised editorial items keep one, hot_signal items have none", async () => {
  const SIGNAL = `${SOURCE}-signal`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
            VALUES (${SIGNAL}, 'Test signal', 'rss', 'T1', 'hot_signal', true, false, '2100-01-01')`;
  const material = (sourceId: string, name: string) =>
    upsertMaterial({ sourceId, url: `https://example.com/${T}-${name}`, title: `${name} ${T}`, bodyText: BODY, bodyHtml: `<p>${BODY}</p>`, bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  // An editorial item the model never summarised, and a hot_signal item carrying an imported summary.
  const { articleId: plain } = await material(SOURCE, "plain");
  await publishArticle(plain);
  const { articleId: signal } = await material(SIGNAL, "signal");
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
            VALUES (${signal}, 1, 'replay', 'pass', 'industry', ${`信号-${T}`}, ${`SIGNAL-SUMMARY-${T}`}, 80, false)`;
  await publishArticle(signal);

  const page = await get(`/api/site/items/${plain}`);
  assert.equal(page.status, 200, "an unsummarised editorial item keeps its page");
  const detail = JSON.parse(page.body) as { summary: string | null; indexable: boolean; markdownAvailable: boolean };
  assert.deepEqual([detail.summary, detail.indexable, detail.markdownAvailable], [null, false, true], "noindex, with its body for export");
  assert.equal((await get(`/items/${plain}/markdown`)).status, 200);
  assert.equal((await get(`/api/site/items/${signal}`)).status, 404, "hot_signal material has no page");
  assert.equal((await get(`/items/${signal}/markdown`)).status, 404);

  const publicId = randomUUID();
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${publicId}, ${`事件-${T}`}, now(), now()) RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`f-${T}`}, ${story!.id}, ${`事实-${T}`}) RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${plain}, 'report'), (${fact!.id}, ${signal}, 'report')`;
  const storyPage = await get(`/api/site/stories/${publicId}`);
  assert.equal(storyPage.status, 200, "a story whose only page is unsummarised still has a page");
  assert.ok(storyPage.body.includes(plain), "it lists the unsummarised editorial report");
  assert.ok(!storyPage.body.includes(signal) && !storyPage.body.includes(`SIGNAL-SUMMARY-${T}`), "and not the hot_signal one");
});

test("an early release keeps the selected ledger in order", async () => {
  const x = await article();
  await publishArticle(x, released());
  const y = await article();
  await publishArticle(y); // still behind the release gate
  await setVisibility(x, { visibility: "withdrawn", reason: "test", version: 0 }, "test");
  await sql`UPDATE articles SET grouped_at = now() WHERE id = ${y}`;
  await publishArticle(y); // grouped: released now

  const [entry] = await sql<{ seq: number }[]>`SELECT max(seq)::int AS seq FROM selected_ledger WHERE article_id = ${y}`;
  assert.ok((await effectiveWatermark()) >= entry!.seq, "the sync watermark covers the released item");
  const snapshot = await get("/api/v1/selected/snapshot?fields=minimal&limit=1000");
  assert.ok(snapshot.body.includes(y), "released item is in the snapshot");
  assert.ok(!snapshot.body.includes(x), "withdrawn item is not");
});

test("a withdrawal waiting behind an unreleased item leaves new snapshots at once, and changes still carry both", async () => {
  const x = await article();
  await publishArticle(x, released());
  const y = await article();
  await publishArticle(y); // behind the release gate: the watermark stays before it
  await setVisibility(x, { visibility: "withdrawn", reason: "test", version: 0 }, "test");

  for (const url of ["/api/v1/selected/snapshot?fields=minimal&limit=1000"]) {
    const body = (await get(url)).body;
    assert.ok(!body.includes(x), `${url} still lists the withdrawn item`);
    assert.ok(!body.includes(y), `${url} lists an item before its release`);
  }
  // A client that saved this snapshot's watermark receives y and x's removal once y is released.
  const snapshot = JSON.parse((await get("/api/v1/selected/snapshot?fields=minimal&limit=1000")).body) as { cursor: string };
  await sql`UPDATE articles SET grouped_at = now() WHERE id = ${y}`;
  await publishArticle(y);
  const changes = JSON.parse((await get(`/api/v1/selected/changes?cursor=${encodeURIComponent(snapshot.cursor)}&limit=100`)).body) as {
    changes: Array<{ op: string; id?: string; item?: { id: string } }>;
  };
  const ours = changes.changes.map((c) => `${c.op}:${c.id ?? c.item?.id}`).filter((c) => c.endsWith(x) || c.endsWith(y));
  assert.deepEqual(ours, [`upsert:${y}`, `remove:${x}`]);
});

test("snapshots answer 304 to their own ETag", async () => {
  for (const url of ["/api/v1/selected/snapshot?fields=minimal&limit=1000"]) {
    const first = await get(url);
    assert.ok(first.etag, `${url} has an ETag`);
    assert.equal((await get(url, { "if-none-match": first.etag! })).status, 304, url);
  }
});

test("v1 story retains website content and fallback ordering without the website-only heat reads", async () => {
  const first = await article();
  const second = await article();
  await publishArticle(first, released());
  await publishArticle(second, released());
  const publicId = await storyFor(first);
  const [story] = await sql<{ id: number }[]>`SELECT id FROM stories WHERE public_id = ${publicId}`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title)
    VALUES (${`v1-development-${T}`}, ${story!.id}, 'Latest development fallback') RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${second}, 'report')`;
  await sql`UPDATE publications SET published_at = now() - interval '1 hour' WHERE article_id = ${first}`;
  await sql`UPDATE stories SET first_report_at = NULL, latest_at = NULL WHERE id = ${story!.id}`;
  const site = JSON.parse((await get(`/api/site/stories/${publicId}`)).body);
  const v1 = JSON.parse((await get(`/api/v1/stories/${publicId}`)).body).story;
  assert.deepEqual({ publicId: v1.publicId, title: v1.title, sourceCount: v1.sourceCount, reportCount: v1.reportCount,
    firstReportAt: v1.firstReportAt, latestAt: v1.latestAt, digest: v1.digest, digestUpdatedAt: v1.digestUpdatedAt },
  { publicId: site.publicId, title: site.title, sourceCount: site.sourceCount, reportCount: site.reportCount,
    firstReportAt: site.firstReportAt, latestAt: site.latestAt, digest: site.digest, digestUpdatedAt: site.digestUpdatedAt });
  assert.equal(v1.latest, 'Latest development fallback');
  assert.deepEqual(v1.reports, site.timeline.slice(0, 50).map((r: any) => ({ id: r.id, title: r.title, summary: r.summary,
    source: { name: r.source.name, firstParty: r.source.firstParty }, publishedAt: r.publishedAt,
    publicationTime: r.publicationTime,
    links: { aihot: `${config.siteUrl}/items/${r.id}`, original: r.originalUrl } })));
  await sql`UPDATE publications SET visible_after = now() + interval '1 day' WHERE article_id = ${second}`;
  const gated = JSON.parse((await get(`/api/v1/stories/${publicId}`)).body).story;
  assert.deepEqual(gated.reports.map((r: any) => r.id), [first]);
  assert.equal(gated.latest, `FACT-${T}`);
});


test("unchanged republishing preserves freshness, while URL-only changes still reach the projection and ledger", async () => {
  const id = await article();
  await publishArticle(id, released());
  const state = async () => (await sql`SELECT xmin::text AS row_version, updated_at, revision, url FROM publications WHERE article_id = ${id}`)[0]!;
  const before = await state();
  const [ledger] = await sql`SELECT max(seq) AS seq FROM selected_ledger WHERE article_id = ${id}`;
  const unchanged = await publishArticle(id);
  assert.equal(unchanged!.changed, false);
  assert.equal(unchanged!.ledger, null);
  assert.deepEqual({ ...await state() }, { ...before }, "no new tuple or freshness timestamp for identical content");
  assert.equal((await sql`SELECT max(seq) AS seq FROM selected_ledger WHERE article_id = ${id}`)[0]!.seq, ledger!.seq);

  const url = `https://example.com/${T}-corrected`;
  await sql`UPDATE articles SET url = ${url} WHERE id = ${id}`;
  const result = await publishArticle(id);
  assert.equal(result!.changed, false, "URL is deliberately outside the presentation fingerprint");
  assert.equal(result!.ledger, "upsert", "the public URL change is still recorded for sync clients");
  const changed = await state();
  assert.equal(changed.url, url);
  assert.notEqual(changed.row_version, before.row_version);
  assert.ok(changed.updated_at >= before.updated_at);
  assert.equal(changed.revision, before.revision);
});

test("share images keep detail metadata and access rules while conditional reads avoid body hydration", async () => {
  const id = await article();
  await publishArticle(id, released());
  const d = JSON.parse((await get(`/api/site/items/${id}`)).body);
  const r = d.research as ResearchProfile | null;
  const kicker = r ? DOCUMENT_TYPES.find(v => v.key === r.documentType)?.label || "研究资料" : d.category ? CATEGORY_LABELS[d.category as keyof typeof CATEGORY_LABELS] : "AI 动态";
  const summary = r && r.status !== "ready" ? `${BASIS_LABELS[r.basis]}，研究方法、结果与证据阶段待确认。` : d.summary;
  const source = d.source.name.replace(/（[^）]*）\s*$/, "");
  const date = beijingDate(d.timelineAt);
  const card = { kicker, title: d.title, subtitle: summary, meta: `${source} · ${date}`,
    badge: null };
  const poster = { url: `${config.siteUrl}/items/${id}`, kicker, title: d.title, summary, source, date, score: null };
  const paths = [[`/og/items/${id}.png`, `"og-${ogEtag(card)}"`], [`/og/posters/${id}.png`, `"poster-${posterEtag(poster)}"`]];
  const queries: string[] = [];
  const previous = sql.options.debug;
  sql.options.debug = (_connection, query) => { queries.push(query); };
  try {
    for (const [path, etag] of paths) {
      const response = await get(path!, { "if-none-match": etag! });
      assert.equal(response.status, 304);
      assert.equal(response.etag, etag);
    }
    assert.equal(queries.filter(q => /AS fingerprint FROM sources/.test(q)).length, 2, "one current permission check per conditional image request");
    assert.equal(queries.length, 4, "two metadata reads and two lightweight permission checks");
    assert.ok(queries.every((q) => !/body_html|body_text|translations|fact_articles/.test(q)), "cards only load their public metadata");
  } finally { sql.options.debug = previous; }
  await sql`UPDATE publications SET visibility = 'summary-only' WHERE article_id = ${id}`;
  assert.equal((await get(paths[0]![0]!, { "if-none-match": paths[0]![1]! })).status, 304, "summary-only pages keep the same allowed share summary");
  try {
    await changeSourcePermission({ participation_mode: "isolated" });
    for (const [path, etag] of paths) assert.equal((await get(path!, { "if-none-match": etag! })).status, 404, "cached share images cannot bypass current source isolation");
  } finally { await changeSourcePermission({ participation_mode: "editorial" }); }
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${id}`;
  for (const [path, etag] of paths) assert.equal((await get(path!, { "if-none-match": etag! })).status, 404, "cached ETags never bypass current visibility");
});

test("minimal sync projection preserves snapshot fields, pagination bindings and ordered changes", async () => {
  const id = await article();
  await publishArticle(id, released());
  await publishArticle(await article(), released());
  const full = JSON.parse((await get('/api/v1/selected/snapshot?fields=default&limit=1000')).body);
  const minimal = JSON.parse((await get('/api/v1/selected/snapshot?fields=minimal&limit=1000')).body);
  const project = (i: any) => ({ id: i.id, title: i.title, source: i.source, publishedAt: i.publishedAt,
    ...(i.publicationTime ? { publicationTime: i.publicationTime } : {}),
    discoveredAt: i.discoveredAt, category: i.category, score: i.score, selected: i.selected, links: { aihot: i.links.aihot } });
  assert.deepEqual(minimal.items, full.items.map(project));
  assert.ok(minimal.items.some((i: any) => i.id === id));
  for (const fields of ['default', 'minimal']) {
    const first = JSON.parse((await get(`/api/v1/selected/snapshot?limit=1${fields === 'minimal' ? '&fields=minimal' : ''}`)).body);
    assert.ok(first.nextPage);
    const response = await get(`/api/v1/selected/snapshot?limit=1000&page=${encodeURIComponent(first.nextPage)}`);
    assert.equal(response.status, 200, 'continuations inherit the projection from the page token');
    const next = JSON.parse(response.body);
    assert.equal(next.fields, fields);
    assert.equal(next.cursor, first.cursor);
    assert.equal(next.asOf, first.asOf);
    assert.equal(next.hasMore, false);
    assert.deepEqual([...first.items, ...next.items], fields === 'minimal' ? minimal.items : full.items);
  }
  const firstPage = JSON.parse((await get('/api/v1/selected/snapshot?fields=minimal&limit=1')).body);
  assert.ok(firstPage.nextPage);
  assert.equal((await get(`/api/v1/selected/snapshot?fields=default&page=${encodeURIComponent(firstPage.nextPage)}`)).status, 400, 'page tokens stay bound to the requested projection');
  await sql`UPDATE analyses SET title_zh = 'Updated sync title', summary_zh = ${'large summary '.repeat(200)} WHERE article_id = ${id}`;
  await publishArticle(id, released());
  const getChanges = async (cursor: string) => {
    const response = await get(`/api/v1/selected/changes?cursor=${encodeURIComponent(cursor)}&limit=100`);
    assert.equal(response.status, 200, response.body);
    return JSON.parse(response.body);
  };
  const fullChanges = await getChanges(full.cursor);
  const minimalChanges = await getChanges(minimal.cursor);
  assert.deepEqual(minimalChanges.changes, fullChanges.changes.map((c: any) => c.op === 'upsert' ? { ...c, item: project(c.item) } : c));
  assert.equal(minimalChanges.changes.find((c: any) => c.item?.id === id)?.item.title, 'Updated sync title');
  await setVisibility(id, { visibility: 'withdrawn', reason: 'sync test', version: 0 }, 'test');
  const removed = await getChanges(minimalChanges.cursor);
  assert.ok(removed.changes.some((c: any) => c.op === 'remove' && c.id === id));
});

async function changeSourcePermission(patch: Record<string, unknown>) {
  const [source] = await sql<{ updated_at: Date }[]>`SELECT updated_at FROM sources WHERE id = ${SOURCE}`;
  await updateSource(SOURCE, { patch, version: source!.updated_at.toISOString(), reason: "permission boundary fixture" }, "test");
}

test("withdrawing full-text permission takes effect in detail, Markdown, RSS and body search before republishing", async () => {
  const id = await article();
  await publishArticle(id, released());
  const term = `FULLTEXT-${T}`;
  assert.ok((await get(`/api/site/items/${id}`)).body.includes(term));
  assert.ok((await get(`/items/${id}/markdown`)).body.includes(term));
  assert.ok((await get("/feed/full.xml")).body.includes(term));
  assert.ok((await get(`/api/v1/items?mode=all&q=${term}`)).body.includes(id));
  assert.ok((await get(`/api/site/pool?tab=relevance&q=${term}`)).body.includes(id));
  try {
    await changeSourcePermission({ site_fulltext: false });
    const [projection] = await sql<{ body_mode: string; syndicate: boolean }[]>`SELECT body_mode, syndicate FROM publications WHERE article_id = ${id}`;
    assert.equal(projection!.body_mode, "full", "the worker has not re-derived this projection");
    const detail = await get(`/api/site/items/${id}`);
    assert.equal(detail.status, 200);
    assert.equal(JSON.parse(detail.body).body, null);
    assert.ok(detail.body.includes(`SUMMARY-${n}-${T}`), "licensed summaries remain readable");
    assert.ok(!(await get(`/items/${id}/markdown`)).body.includes(term));
    assert.ok(!(await get("/feed/full.xml")).body.includes(term));
    assert.ok(!(await get(`/api/v1/items?mode=all&q=${term}`)).body.includes(id), "a stale body index cannot reveal matching text");
    assert.ok(!(await get(`/api/site/pool?tab=relevance&q=${term}`)).body.includes(id));
    assert.ok(!(await get(`/api/site/pool?tab=relevance&q=${term}%20FULLTEXT`)).body.includes(id), "the unsplit relevance path also enforces permission");
  } finally {
    await sql`UPDATE sources SET site_fulltext = true WHERE id = ${SOURCE}`;
  }
  assert.ok((await get(`/api/site/items/${id}`)).body.includes(term), "restoring current permission permits the still-valid projection");
});

test("withdrawing RSS redistribution keeps licensed website full text while full RSS immediately falls back to a summary", async () => {
  const id = await article();
  await publishArticle(id, released());
  const term = `FULLTEXT-${T}`;
  try {
    await changeSourcePermission({ syndicate_fulltext: false });
    assert.ok((await get(`/api/site/items/${id}`)).body.includes(term));
    assert.ok((await get(`/items/${id}/markdown`)).body.includes(term));
    const feed = (await get("/feed/full.xml")).body;
    assert.ok(feed.includes(id) && !feed.includes(term));
  } finally {
    await sql`UPDATE sources SET syndicate_fulltext = true WHERE id = ${SOURCE}`;
  }
  assert.ok((await get("/feed/full.xml")).body.includes(term));
});

test("isolating a source hides stale projected items and old sync upserts before the queued republish without suppressing an independent source", async () => {
  const controlSource = `${SOURCE}-permission-control`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
    VALUES (${controlSource}, 'Permission control', 'rss', 'T1', 'editorial', true, true, '2100-01-01')`;
  const cursor = JSON.parse((await get("/api/v1/selected/snapshot?limit=1000")).body).cursor;
  const id = await article(), control = await article(controlSource);
  await publishArticle(id, released());
  await publishArticle(control, released());
  const story = await storyFor(id);
  const reportKey = "2099-12-30";
  await sql`INSERT INTO reports (kind,key,window_start,window_end,content,generated_at,origin)
    VALUES ('daily',${reportKey},now()-interval '1 day',now(),${sql.json({ sections: [{ label: 'Fixture', items: [
      { itemId: id, title: 'Restricted fixture', summary: 'RESTRICTED-CITATION', sourceUrl: 'https://example.com/restricted', sourceName: 'Test' },
      { itemId: control, title: 'Control fixture', summary: 'CONTROL-CITATION', sourceUrl: 'https://example.com/control', sourceName: 'Control' },
    ] }], flashes: [] } as never)},now(),'manual')
    ON CONFLICT (kind,key) DO UPDATE SET content=EXCLUDED.content`;
  assert.ok((await get("/api/v1/items?mode=selected")).body.includes(id));
  try {
    await changeSourcePermission({ participation_mode: "isolated" });
    const [projection] = await sql<{ visibility: string; selected: boolean }[]>`SELECT visibility,selected FROM publications WHERE article_id=${id}`;
    assert.deepEqual({ ...projection! }, { visibility: "public", selected: true }, "the original public projection is intentionally still stale");
    for (const url of ["/api/v1/items?mode=selected", "/api/v1/items?mode=all", "/api/v1/selected/snapshot?fields=default&limit=1000", "/api/v1/selected/snapshot?fields=minimal&limit=1000", "/feed.xml", "/feed/full.xml", "/feed/all.xml", "/api/site/pool"]) {
      const response = await get(url);
      assert.equal(response.status, 200, response.body);
      assert.ok(!response.body.includes(id), `${url} still sends the isolated item`);
      assert.ok(response.body.includes(control), `${url} unexpectedly suppresses the independent source`);
    }
    for (const url of [`/api/site/items/${id}`, `/api/site/items/${id}/original`, `/items/${id}/markdown`, `/api/site/stories/${story}`, `/api/v1/stories/${story}`]) {
      assert.equal((await get(url)).status, 404, url);
    }
    const changed = await get(`/api/v1/selected/changes?limit=100&cursor=${encodeURIComponent(cursor)}`);
    assert.equal(changed.status, 409);
    assert.equal(JSON.parse(changed.body).code, "snapshot_required");
    for (const url of [`/api/site/reports/daily/${reportKey}`, `/api/v1/dailies/${reportKey}`]) {
      const response = await get(url);
      assert.ok(!response.body.includes("RESTRICTED-CITATION") && response.body.includes("CONTROL-CITATION"), url);
    }
  } finally {
    await changeSourcePermission({ participation_mode: "editorial" });
    await sql`DELETE FROM reports WHERE kind = 'daily' AND key = ${reportKey}`;
  }
  assert.ok((await get("/api/v1/items?mode=selected")).body.includes(id), "restoring the source permits the unchanged public projection");
  assert.equal((await get(`/api/site/items/${id}`)).status, 200);
});

test("temporary isolation and restoration before republishing invalidates both epochs without inventing ledger operations", async () => {
  const prior = JSON.parse((await get("/api/v1/selected/snapshot?limit=1000")).body);
  const id = await article();
  await publishArticle(id, released());
  const first = JSON.parse((await get("/api/v1/selected/snapshot?limit=1")).body);
  assert.ok(first.nextPage, "fixture has enough selected rows to test continuation invalidation");
  const [before] = await sql<{ seq: number; in_set: boolean; payload_hash: string }[]>`
    SELECT st.in_set, st.payload_hash, (SELECT coalesce(max(seq),0)::int FROM selected_ledger WHERE article_id=${id}) AS seq
    FROM selected_state st WHERE st.article_id=${id}`;
  let isolatedCursor: string;
  try {
    await changeSourcePermission({ participation_mode: "isolated" });
    assert.equal((await get(`/api/v1/selected/changes?cursor=${encodeURIComponent(prior.cursor)}`)).status, 409);
    assert.equal((await get(`/api/v1/selected/changes?cursor=${encodeURIComponent(first.cursor)}`)).status, 409, "even a watermark past the old upsert must reset");
    assert.equal((await get(`/api/v1/selected/snapshot?page=${encodeURIComponent(first.nextPage)}`)).status, 400);
    const isolated = await get("/api/v1/selected/snapshot?limit=1000");
    assert.ok(!isolated.body.includes(id));
    isolatedCursor = JSON.parse(isolated.body).cursor;
  } finally {
    await changeSourcePermission({ participation_mode: "editorial" });
  }
  assert.equal((await get(`/api/v1/selected/changes?cursor=${encodeURIComponent(isolatedCursor!)}`)).status, 409, "the temporary empty snapshot cannot silently miss the restored item");
  await republishSource(SOURCE);
  const [after] = await sql<{ seq: number; in_set: boolean; payload_hash: string }[]>`
    SELECT st.in_set, st.payload_hash, (SELECT coalesce(max(seq),0)::int FROM selected_ledger WHERE article_id=${id}) AS seq
    FROM selected_state st WHERE st.article_id=${id}`;
  assert.deepEqual({ ...after! }, { ...before! }, "restoration with an unchanged selected payload does not emit a compensating upsert");
  const restored = await get("/api/v1/selected/snapshot?limit=1000");
  assert.ok(restored.body.includes(id));
  const changes = await get(`/api/v1/selected/changes?cursor=${encodeURIComponent(JSON.parse(restored.body).cursor)}`);
  assert.equal(changes.status, 200);
});

test("current full-text permission also gates X text, translations and quoted posts on old website and Markdown exits", async () => {
  const id = await article();
  const text = `X-FULL-${T}`, quote = `X-QUOTE-${T}`, translated = `X-TRANSLATED-${T}`;
  await sql`UPDATE articles SET x_post=${sql.json({ tweetId: '123456789', authorName: 'Fixture', handle: 'fixture', text,
    quoted: { authorName: 'Quoted', handle: 'quoted', text: quote, url: 'https://x.com/quoted/status/123456788' } })} WHERE id=${id}`;
  await sql`INSERT INTO translations (article_id,revision,body_html,body_text,origin) VALUES (${id},1,${'<p>'+translated+'</p>'},${translated},'source')`;
  await publishArticle(id, released());
  assert.ok((await get(`/api/site/items/${id}/original`)).body.includes(text));
  assert.ok((await get(`/items/${id}/markdown`)).body.includes(quote));
  try {
    await changeSourcePermission({ site_fulltext: false });
    const response = await get(`/api/site/items/${id}`);
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).body, null);
    assert.equal(JSON.parse(response.body).x, null);
    for (const url of [`/api/site/items/${id}/original`, `/items/${id}/markdown`, "/api/site/pool"]) {
      const body = (await get(url)).body;
      assert.ok(!body.includes(text) && !body.includes(quote) && !body.includes(translated), url);
    }
  } finally { await changeSourcePermission({ site_fulltext: true }); }
  assert.ok((await get(`/items/${id}/markdown`)).body.includes(text));
});

test("warmed public caches and conditional requests observe source permission changes across processes before republishing", async () => {
  const controlSource = `${SOURCE}-cache-control`;
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,site_fulltext,syndicate_fulltext,next_fetch_at)
    VALUES (${controlSource},'Cache control','rss','T1','editorial',true,true,'2100-01-01')`;
  const id = await article(), control = await article(controlSource);
  const stories = [await storyFor(id), await storyFor(control)];
  await sql`UPDATE articles SET media=${sql.json([{ kind:'image',url:'https://example.com/permission-cover.png',width:800,height:600 }])} WHERE id IN (${id},${control})`;
  await publishArticle(id, released()); await publishArticle(control, released());
  const storyRows = await sql<{ id: number; public_id: string }[]>`SELECT id,public_id::text FROM stories WHERE public_id=ANY(${stories}::uuid[])`;
  const reportKey = '2099-12-29', topic = `cache-permission-${T}`, topicTag = `permission:${T}`;
  await sql`UPDATE publications SET tags=ARRAY[${topicTag}] WHERE article_id IN (${id},${control})`;
  await sql`INSERT INTO topics (slug,name,grp,tags,definition,related,position) VALUES (${topic},'Permission cache','field',ARRAY[${topicTag}],'Fixture','{}',999)`;
  await sql`INSERT INTO reports (kind,key,window_start,window_end,content,generated_at,origin)
    VALUES ('daily',${reportKey},now()-interval '1 day',now(),${sql.json({ sections:[{label:'Fixture',items:[
      { itemId:id,title:'CACHE-RESTRICTED-HEADLINE',summary:'CACHE-RESTRICTED-SUMMARY',sourceUrl:'https://example.com/restricted',sourceName:'Test' },
      { itemId:control,title:'CACHE-CONTROL-HEADLINE',summary:'CACHE-CONTROL-SUMMARY',sourceUrl:'https://example.com/control',sourceName:'Control' },
    ]}],flashes:[] } as never)},now(),'manual')`;
  const entries = [id,control].map((item,i) => {
    const story = storyRows.find(row=>row.public_id===stories[i])!;
    return { rank:i+1,storyId:Number(story.id),storyPublicId:story.public_id,title:`CACHE-HOT-${i}-${T}`,heat:10,
      trend:'flat',trendPct:0,badges:[],participantCount:1,sourceCount:1,signalCount:0,reportCount:1,
      sourceNames:[i?'Cache control':'Test publication'],latestAt:new Date().toISOString(),firstReportAt:new Date().toISOString(),
      representativeItemId:item,representativeUrl:'https://example.com/fixture',representativeSource:i?'Cache control':'Test publication',
      participants:[{name:i?'Cache control':'Test publication',kind:'editorial',tier:'T1'}] };
  });
  const [ranking] = await sql<{ id:number }[]>`INSERT INTO hot_rankings (computed_at,rule_version,entries,published)
    VALUES (now(),'permission-cache-fixture',${sql.json(entries)},true) RETURNING id`;
  try {
    const warmedHot = await get('/api/site/hot');
    assert.ok(JSON.parse(warmedHot.body).entries.find((e:any)=>e.representative?.id===id)?.cover);
    assert.ok((await get('/api/v1/hot-topics')).body.includes(id));
    const warmedTopics = await get('/api/site/topics');
    assert.equal(JSON.parse(warmedTopics.body).topics.find((t:any)=>t.slug===topic).total,2);
    const warmedReports = await get('/api/v1/dailies');
    assert.ok(warmedReports.body.includes('CACHE-RESTRICTED-HEADLINE'));
    const warmedStats = await get('/api/site/stats'); assert.ok(warmedStats.body.includes(id));
    const callMcp = async () => {
      const response = await app.inject({ method:'POST',url:'/api/mcp',headers:{host:'localhost','content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-03-26'},
        payload:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:MCP_NAMES.latest,arguments:{mode:'selected',window:'24h',limit:30}}} });
      assert.equal(response.statusCode,200,response.body); return response.body;
    };
    assert.ok((await callMcp()).includes(id));
    const warmedSitemap = await get('/sitemap.xml'); assert.ok(warmedSitemap.body.includes(id));
    // Simulate a second process: no in-process updateSource callback, only persisted permission changes.
    await sql`UPDATE sources SET site_fulltext=false,updated_at=clock_timestamp() WHERE id=${SOURCE}`;
    const withoutPicture = JSON.parse((await get('/api/site/hot', {'if-none-match':warmedHot.etag!})).body);
    assert.equal(withoutPicture.entries.find((e:any)=>e.representative?.id===id)?.cover,null);
    assert.ok(withoutPicture.entries.find((e:any)=>e.representative?.id===control)?.cover);
    await changeSourcePermission({ site_fulltext:true });
    const restoredPicture = JSON.parse((await get('/api/site/hot')).body);
    assert.ok(restoredPicture.entries.find((e:any)=>e.representative?.id===id)?.cover);
    await changeSourcePermission({ participation_mode:'isolated' });
    for (const url of ['/api/site/hot','/api/v1/hot-topics']) {
      const response = await get(url); assert.ok(!response.body.includes(id) && response.body.includes(control),url);
    }
    const topics = await get('/api/site/topics', {'if-none-match':warmedTopics.etag!});
    assert.equal(topics.status,200); assert.equal(JSON.parse(topics.body).topics.find((t:any)=>t.slug===topic).total,1);
    const reports = await get('/api/v1/dailies', {'if-none-match':warmedReports.etag!});
    assert.equal(reports.status,200); assert.ok(!reports.body.includes('CACHE-RESTRICTED-HEADLINE') && reports.body.includes('CACHE-CONTROL-HEADLINE'));
    const stats = await get('/api/site/stats', {'if-none-match':warmedStats.etag!});
    assert.equal(stats.status,200); assert.ok(!stats.body.includes(id) && stats.body.includes(control));
    const mcp = await callMcp(); assert.ok(!mcp.includes(id) && mcp.includes(control),"a warmed MCP answer cannot outlive source isolation");
    const sitemap = await get('/sitemap.xml', {'if-none-match':warmedSitemap.etag!});
    assert.equal(sitemap.status,200); assert.ok(!sitemap.body.includes(id) && sitemap.body.includes(control));
    const [sameRanking] = await sql<{ id:number }[]>`SELECT id FROM hot_rankings WHERE published ORDER BY computed_at DESC LIMIT 1`;
    assert.equal(sameRanking!.id,ranking!.id,"all read boundaries changed without a new ranking or republish");
  } finally {
    await changeSourcePermission({ participation_mode:'editorial',site_fulltext:true });
    await sql`DELETE FROM hot_rankings WHERE id=${ranking!.id}`;
    await sql`DELETE FROM reports WHERE kind='daily' AND key=${reportKey}`;
    await sql`DELETE FROM topics WHERE slug=${topic}`;
  }
});
