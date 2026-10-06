import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { transformSync } from "rolldown/utils";
import type { ItemSummary, SiteItemDetail } from "@aihot/contracts/site";
import type { ResearchProfile } from "@aihot/contracts/research";
import { INDEX_CONTENT_SUMMARY } from "@aihot/contracts/site";

// Use the real TSX components in Node's renderer, without a browser, server or network calls.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      const url = new URL(specifier, context.parentURL);
      if (!extname(url.pathname)) {
        for (const suffix of [".ts", ".tsx"]) {
          const candidate = new URL(url.href + suffix);
          if (existsSync(candidate)) return nextResolve(candidate.href, context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".tsx")) {
      const result = transformSync(fileURLToPath(url), readFileSync(new URL(url), "utf8"), { jsx: { runtime: "automatic" }, tsconfig: false });
      if (result.errors.length) throw new AggregateError(result.errors, "Could not render the TSX component");
      return { format: "module", source: result.code, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
after(() => hooks.deregister());

const { ResearchRecord, ResearchList } = await import("../app/features/research/ResearchRecord.tsx");
const { ResearchTimeline } = await import("../app/features/research/ResearchTimeline.tsx");
const { ResearchDetail } = await import("../app/features/research/ResearchDetail.tsx");
const { FeedItem } = await import("../app/features/feed/FeedItem.tsx");

const research: ResearchProfile = {
  version: 1,
  bibliography: { doi: "10.1234/source-record", pmid: "12345678", authors: ["Source Author"], journal: "Source Journal", publishedDate: "2026-09-30", publicationTypes: ["Journal Article"], isPreprint: false },
  areas: ["translation"], foci: [], documentType: "original-research", evidenceStages: ["clinical"], clinicalPhase: "III", origin: "primary",
  basis: "fulltext", materialKind: "fulltext", status: "ready",
  claims: { object: "Old study object", question: "Old study question", methods: "Old study methods", results: "Old study results", limitations: "Old study limitations" },
};
const item: ItemSummary = {
  id: "source-index", revision: 1, contentStage: "index", title: "旧译标题", originalTitle: "Original source title",
  summary: "Old model summary", reason: "Old recommendation", research,
  source: { id: "source", name: "Source collection", kind: "rss", firstParty: true, iconUrl: null },
  links: { aihot: "https://example.org/items/source-index", original: "https://publisher.example/article" },
  publishedAt: null, discoveredAt: "2026-10-06T08:30:00Z", timelineAt: "2026-09-30T00:00:00Z",
  category: null, tags: [], score: 99, selected: true, channel: "news", story: null, x: null,
};
const detail: SiteItemDetail = {
  ...item, readingMode: "full", author: null, language: "en",
  body: { zh: "<p>Old translated body</p>", original: "<p>Old source body</p>", zhKind: "translation", complete: true },
  outline: [], relatedStories: [], indexable: true, markdownAvailable: true, group: null,
  hasTranslation: true, bodyLanguage: "zh",
};
const render = (element: ReactElement) => renderToStaticMarkup(createElement(MemoryRouter, null, element));

test("index records consistently show source metadata and the pending note across library, timeline and feed", () => {
  const views = [
    createElement(ResearchRecord, { item, variant: "editorial" }),
    createElement(ResearchList, { items: [item] }),
    createElement(ResearchTimeline, { items: [item], editorial: true }),
    createElement(FeedItem, { item, showTags: true }),
  ];
  for (const view of views) {
    const html = render(view);
    assert.ok(html.includes("Original source title"));
    assert.ok(html.includes("Source Journal"));
    assert.ok(html.includes("2026-09-30"));
    assert.ok(html.includes("导读整理中"));
    assert.ok(html.includes(INDEX_CONTENT_SUMMARY));
    assert.ok(html.includes('href="https://publisher.example/article"'));
    for (const stale of ["旧译标题", "Old model summary", "Old recommendation", "Old study", "精选", "临床", "基于已获取原文"]) {
      assert.ok(!html.includes(stale), `index view must omit ${stale}`);
    }
    assert.ok(!html.includes("08:30"), "arrival time is not rendered as the publication clock");
  }
});

test("index detail preserves bibliography even in summary-only mode and does not render an unfinished study note", () => {
  for (const readingMode of ["full", "summary-only"] as const) {
    const html = render(createElement(ResearchDetail, { item: { ...detail, readingMode } }));
    for (const value of ["Original source title", "Source Journal", "Source Author", "10.1234/source-record", "12345678", "2026-09-30", "导读整理中", INDEX_CONTENT_SUMMARY]) {
      assert.ok(html.includes(value), `index detail must preserve ${value}`);
    }
    assert.ok(html.includes('href="https://publisher.example/article"'));
    for (const unfinished of ["旧译标题", "Old study", "Old model summary", "Old recommendation", "Old translated body", "Old source body", "待核对的信息", "本篇导读的材料范围", "为什么值得读", "导出笔记", "临床 III", "基于已获取原文"]) {
      assert.ok(!html.includes(unfinished), `index detail must omit ${unfinished}`);
    }
  }
});

test("processed pending and insufficient research keep their own material scope, and older cards need no new fields", () => {
  for (const status of ["pending", "insufficient"] as const) {
    const profile: ResearchProfile = { ...research, status, basis: status === "insufficient" ? "title" : "abstract", materialKind: status === "insufficient" ? "title" : "paper-abstract", claims: { object: null, question: null, methods: null, results: null, limitations: null } };
    const html = render(createElement(ResearchDetail, { item: { ...detail, contentStage: "processed", research: profile, body: null } }));
    assert.ok(!html.includes("资料索引</h2>"));
    assert.ok(!html.includes(INDEX_CONTENT_SUMMARY));
    assert.ok(html.includes("本篇导读的材料范围"));
    assert.ok(html.includes(status === "insufficient" ? "暂不生成深入导读" : "导读尚未满足基本完整度"));
  }
  const { contentStage: _stage, originalTitle: _originalTitle, links: _links, ...oldCard } = item;
  const html = render(createElement(ResearchRecord, { item: { ...oldCard, title: "Saved older title", research: null } }));
  assert.ok(html.includes("Saved older title"));
  assert.ok(html.includes("研究结构待整理"));
  assert.ok(!html.includes(INDEX_CONTENT_SUMMARY));
});
