import { z } from "zod";
import type { ResearchProfile } from "@aihot/contracts/research";
import type { ResearchMaterial } from "./profile.ts";

const plainText = (value: string) => !/<(?:\/?[a-z][^<>]*>|!--|!\[CDATA\[|\?xml)/i.test(value.replace(/&lt;/gi, "<").replace(/&gt;/gi, ">"));

/** Private material read by an editor; only its source links enter the public projection. */
export const EditorialResearchMaterialSchema = z.object({
  kind: z.enum(["fulltext", "abstract-supplement", "publisher-summary"]),
  text: z.string().max(250_000).trim().min(100).refine(plainText, "研究材料必须为纯文本，请移除 HTML/XML 标记"),
  sources: z.array(z.object({
    label: z.string().max(120).trim().min(1).refine(plainText, "来源名称必须为纯文本"),
    url: z.string().max(2048).url().refine(value => {
      try {
        const url = new URL(value);
        return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !/[\u0000-\u0020\u007f]/.test(value);
      } catch { return false; }
    }, "研究来源必须是无登录凭据的 HTTP(S) 地址"),
  }).strict()).min(1).max(10),
}).strict();

export type EditorialResearchMaterial = z.infer<typeof EditorialResearchMaterialSchema>;

/** Invalid legacy JSON cannot expand the material against which public claims are checked. */
export function editorialResearchMaterial(value: unknown): EditorialResearchMaterial | null {
  const parsed = EditorialResearchMaterialSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function effectiveResearchMaterial(base: ResearchMaterial, editorial: EditorialResearchMaterial | null): ResearchMaterial {
  return editorial ? {
    ...base,
    bodyText: editorial.text,
    excerpt: null,
    fullText: editorial.kind === "fulltext",
    materialKind: editorial.kind,
  } : base;
}

export function withResearchMaterialSources(profile: ResearchProfile, editorial: EditorialResearchMaterial | null): ResearchProfile {
  // Do not trust source links copied into a stored profile: the current private material owns them.
  const { materialSources: _previous, ...publicProfile } = profile;
  return editorial ? { ...publicProfile, materialSources: editorial.sources.map(({ label, url }) => ({ label, url })) } : publicProfile;
}
