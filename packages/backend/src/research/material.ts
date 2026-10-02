import { load } from "cheerio";
import { sha256, stableJson } from "../lib/ids.ts";
import type { ResearchMaterial } from "./profile.ts";

export const RESEARCH_PROCESSING_VERSION = "reliability-1";
const superscript: Record<string, string> = Object.fromEntries(Array.from("0123456789+-=()in").map((c, i) => [c, Array.from("⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁱⁿ")[i]!]));
const subscript: Record<string, string> = Object.fromEntries(Array.from("0123456789+-=()").map((c, i) => [c, Array.from("₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎")[i]!]));

/** Parse scientific HTML once. Comparisons are text, not an arbitrary <…> tag span.
 * Recognise encoded markup without decoding &lt; comparisons before the HTML parser.
 * The output is also safe to normalise again (plain P < 0.05 survives).
 */
export function scientificText(value: string): string {
  const markup = value.replace(/&lt;(\/?(?:i|b|em|strong|p|h[1-6]|div|br|sup|sub|span)(?:\s[^&<>]*?)?\s*\/?)&gt;/gi, "<$1>");
  const $ = load(markup, {}, false);
  $("script,style,noscript").remove();
  for (const [selector, alphabet, marker] of [["sup", superscript, "^"], ["sub", subscript, "_"]] as const) {
    $(selector).each((_, e) => {
      const text = $(e).text();
      $(e).replaceWith(Array.from(text).every(c => c in alphabet) ? Array.from(text).map(c => alphabet[c]).join("") : `${marker}{${text}}`);
    });
  }
  $("br").replaceWith("\n");
  $("p,div,h1,h2,h3,h4,h5,h6,li,section").each((_, e) => { $(e).prepend("\n"); $(e).append("\n"); });
  return $.root().text().replace(/\u00a0/g, " ").replace(/[\t\r ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function researchMaterialFingerprint(material: ResearchMaterial): string {
  return sha256(stableJson({ title: material.title, text: material.bodyText || material.excerpt || "", bibliography: material.bibliography ?? null, materialKind: material.materialKind ?? null }));
}
