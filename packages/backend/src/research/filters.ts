import type { ResearchFilters } from "@aihot/contracts/research";
import { FACET_GROUPS } from "@aihot/contracts/research";
import { sql } from "../db.ts";
export function researchCondition(filters: ResearchFilters) {
  const keys = { area: "areas", focus: "foci", docType: "documentType", evidence: "evidenceStages", origin: "origin" } as const;
  let out = sql``;
  for (const group of FACET_GROUPS) {
    const values = filters[group.param];
    if (!values?.length) continue;
    const key = keys[group.param];
    const conditions = values.map(value => sql`p.research @> ${sql.json({ [key]: group.param === "docType" || group.param === "origin" ? value : [value] })}::jsonb`);
    const any = conditions.slice(1).reduce((a, b) => sql`${a} OR ${b}`, conditions[0]!);
    out = sql`${out} AND (${any})`;
  }
  return out;
}
