import { load } from "cheerio";
import { sql } from "../db.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { collapseWhitespace } from "../lib/text.ts";
import { normalizeDoi, normalizeBibliography, europePmcBibliography } from "./profile.ts";
import type { Bibliography } from "@aihot/contracts/research";
import { scientificText } from "./material.ts";
export const researchTitleKey = (s: string) => collapseWhitespace(scientificText(s)).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
/** Publisher metadata and its explicitly marked abstract, never a reference-list identifier. */
export function publisherResearchMaterial(html: string, title: string, url: string) {
  const $ = load(html);
  const meta = (name:string) => $(`meta[name="${name}"]`).first().attr("content") || null;
  if (researchTitleKey(meta("citation_title") || "") !== researchTitleKey(title)) return null;
  const canonical = meta("citation_fulltext_html_url");
  if (canonical) { try { const c=new URL(canonical),u=new URL(url); if(c.hostname!==u.hostname || c.pathname!==u.pathname) return null; } catch { return null; } }
  const bibliography = normalizeBibliography({
    doi:meta("citation_doi"), journal:meta("citation_journal_title"),
    authors:$("meta[name='citation_author']").map((_,e)=>$(e).attr("content") || "").get(),
    publishedDate:(meta("citation_online_date") || meta("citation_publication_date"))?.replace(/\//g,"-"),
    publicationTypes:[meta("citation_article_type")].filter(Boolean), isPreprint:false,
  });
  const abstract = scientificText($("#Abs1-content").html() || "");
  return {bibliography,abstract:abstract.length>=100?abstract:null};
}
/** Fetches a free source record inside collection jobs only. Never called from a public request. */
export async function enrichResearchMaterial(articleId: string): Promise<void> {
  const [a] = await sql<{ url: string; title: string; body_text: string | null; excerpt: string | null; bibliography: Bibliography | null; revision: number; kind: string }[]>`
    SELECT a.url, a.title, coalesce(a.research_abstract,a.body_text) AS body_text, a.excerpt, a.bibliography, a.revision, s.kind
    FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
  if (!a || !["rss", "json_list"].includes(a.kind)) return;
  const current = normalizeBibliography(a.bibliography);
  const url = new URL(a.url);
  let doi = current.doi;
  let pmid = current.pmid;
  if (url.hostname === "europepmc.org") pmid ||= url.pathname.match(/^\/article\/MED\/(\d+)$/)?.[1] ?? null;
  if (/^(?:www\.)?nature\.com$/.test(url.hostname)) {
    const page = await guardedFetch(a.url, { timeoutMs: 15_000 });
    if (page.status === 200) {
      const publisher = publisherResearchMaterial(page.text(),a.title,a.url);
      if (publisher) {
        const b=publisher.bibliography;
        const merged=normalizeBibliography({...current,doi:b.doi || current.doi,journal:b.journal || current.journal,
          authors:b.authors.length?b.authors:current.authors,publishedDate:b.publishedDate || current.publishedDate,
          publicationTypes:b.publicationTypes.length?b.publicationTypes:current.publicationTypes,isPreprint:b.isPreprint});
        doi=merged.doi;
        await sql`UPDATE articles SET bibliography=${sql.json(merged as never)},
          research_abstract=coalesce(${publisher.abstract},research_abstract),research_source_url=${a.url},
          research_material_kind=${b.publicationTypes.some(t=>/news|highlight/i.test(t)) ? "publisher-summary" : "paper-abstract"},
          research_checked_at=now(),updated_at=now() WHERE id=${articleId} AND revision=${a.revision}`;
        if (publisher.abstract && merged.doi && merged.journal) return;
      }
    }
  }
  // Restrict the free lookup to the existing academic source families.
  if (!doi && !pmid && !/^(?:www\.)?(?:nature\.com|europepmc\.org)$/.test(url.hostname)) return;
  const query = doi ? `DOI:"${doi.replace(/"/g, "")}"` : pmid ? `EXT_ID:${pmid} AND SRC:MED` : `TITLE:"${a.title.replace(/["\\]/g, " ").slice(0, 500)}"`;
  const endpoint = new URL("https://www.ebi.ac.uk/europepmc/webservices/rest/search");
  endpoint.search = new URLSearchParams({ query, format: "json", resultType: "core", pageSize: "5" }).toString();
  const res = await guardedFetch(endpoint.toString(), { timeoutMs: 15_000 });
  if (res.status !== 200) throw new Error(`bibliography lookup HTTP ${res.status}`);
  const data = JSON.parse(res.text());
  const matches: Record<string, any>[] = Array.isArray(data.resultList?.result) ? data.resultList.result : [];
  const match = matches.find(r => doi ? normalizeDoi(r.doi) === doi : pmid ? String(r.pmid || r.id) === pmid : researchTitleKey(String(r.title || "")) === researchTitleKey(a.title));
  if (!match || researchTitleKey(String(match.title || "")) !== researchTitleKey(a.title)) return;
  const bibliography = europePmcBibliography(match);
  const abstract = typeof match.abstractText === "string" ? scientificText(match.abstractText) : null;
  const useful = abstract && abstract.length >= 100;
  // The verified source abstract is additive: historical bodies, translations and selection stay intact.
  // The research extraction has its own source-support record and receipt; publication hashes include it.
  await sql`UPDATE articles SET bibliography = ${sql.json(bibliography as never)},
    research_abstract = CASE WHEN ${!!useful} THEN ${abstract} ELSE research_abstract END,
    research_source_url = ${endpoint.toString()},
    research_material_kind = ${bibliography.publicationTypes.some(t=>/news|highlight/i.test(t)) ? "publisher-summary" : "paper-abstract"},
    research_checked_at = now(), updated_at = now()
    WHERE id = ${articleId} AND revision = ${a.revision}`;
}

/** Preserve article ids as aliases; choose a stable, earliest public paper as the DOI representative. */
export async function reconcileResearchDoi(articleId: string): Promise<string[]> {
  return sql.begin(async tx => {
    const [item] = await tx<{ doi: string | null }[]>`SELECT coalesce(o.fields->'researchBibliography',a.bibliography)->>'doi' AS doi
      FROM articles a LEFT JOIN editorial_overrides o ON o.article_id=a.id WHERE a.id = ${articleId}`;
    if (!item?.doi) return [];
    await tx`SELECT pg_advisory_xact_lock(hashtext(${'research-doi:' + item.doi}))`;
    const rows = await tx<{ id: string }[]>`SELECT a.id FROM articles a JOIN sources s ON s.id = a.source_id
      LEFT JOIN editorial_overrides o ON o.article_id=a.id
      WHERE coalesce(o.fields->'researchBibliography',a.bibliography)->>'doi' = ${item.doi} AND s.participation_mode = 'editorial'
      AND coalesce(o.visibility, 'public') = 'public'
      ORDER BY a.discovered_at, a.id FOR UPDATE OF a`;
    if (!rows.length) return [];
    const canonical = rows[0]!.id;
    await tx`UPDATE articles SET canonical_article_id = NULL WHERE id = ${canonical}`;
    for (const row of rows.slice(1)) {
      await tx`UPDATE articles SET canonical_article_id = ${canonical} WHERE id = ${row.id}`;
      await tx`INSERT INTO article_discoveries (article_id, source_id, via, discovered_at, source_url)
        SELECT ${canonical}, source_id, via, discovered_at, source_url FROM article_discoveries WHERE article_id = ${row.id}
        ON CONFLICT (article_id, source_id, via) DO NOTHING`;
    }
    return rows.map(r => r.id);
  });
}
