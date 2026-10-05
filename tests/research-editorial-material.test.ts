import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EditorialResearchMaterialSchema, editorialResearchMaterial, effectiveResearchMaterial, withResearchMaterialSources,
} from "@aihot/backend/research/editorial-material";
import { normalizeBibliography, validateAdminResearch, validateStoredResearch } from "@aihot/backend/research/profile";
import { researchBasisLabel } from "@aihot/contracts/research";

const text = "We investigated a drug in cultured cells. Our study used cell viability assays and reported reduced activity. Results: P < 0.05 and P > 0.01.";
const bibliography = normalizeBibliography({ doi: "10.1234/editorial-test", journal: "Test Journal", publicationTypes: ["Journal Article"] });
const base = { title: "Drug study", bodyText: text, bibliography };
const sources = [{ label: "公开补充材料", url: "https://example.org/supplement.docx" }];
const supplemental = { kind: "abstract-supplement" as const, text: `${text}\nMice received the study drug in vivo. The animal results showed reduced inflammation.`, sources };

test("editorial material accepts scientific comparisons but rejects markup, oversized input and unsafe source URLs", () => {
  const kinds = ["abstract-supplement", "fulltext", "publisher-summary"] as const;
  for (const kind of kinds) {
    const material = { ...supplemental, kind };
    assert.deepEqual(EditorialResearchMaterialSchema.parse(material), material);
  }
  assert.equal(editorialResearchMaterial({ ...supplemental, kind: "paper-abstract" }), null);
  const invalid = [
    { ...supplemental, text: "Short text" },
    { ...supplemental, text: "x".repeat(250_001) },
    { ...supplemental, text: `<p>${text}</p>` },
    { ...supplemental, text: `${text}<script>alert(1)</script>` },
    { ...supplemental, text: `&lt;div&gt;${text}&lt;/div&gt;` },
    { ...supplemental, sources: [] },
    { ...supplemental, sources: Array.from({ length: 11 }, () => sources[0]) },
    { ...supplemental, sources: [{ ...sources[0], label: " " }] },
    { ...supplemental, sources: [{ ...sources[0], label: "x".repeat(121) }] },
    { ...supplemental, sources: [{ ...sources[0], label: "<b>Source</b>" }] },
    ...["not a url", "javascript:alert(1)", "file:///tmp/paper", "ftp://example.org/paper", "https://editor:secret@example.org/paper", `https://example.org/${"x".repeat(2048)}`]
      .map(url => ({ ...supplemental, sources: [{ label: "Source", url }] })),
    { ...supplemental, sources: [{ ...sources[0], quote: "private evidence" }] },
  ];
  for (const kind of kinds) {
    for (const value of invalid) assert.equal(editorialResearchMaterial({ ...value, kind }), null);
  }
});

test("publisher reports and regulatory materials support public fields without claiming paper full text", () => {
  const clinicalQuote = "The FDA reviewed a clinical trial that enrolled patients with the disease.";
  const publisher = {
    kind: "publisher-summary" as const,
    text: `Publisher report: A medicine received regulatory review. ${clinicalQuote} The public report described the regulatory decision and its scope.`,
    sources: [
      { label: "出版商报道", url: "https://example.org/news/medicine" },
      { label: "FDA 监管页面", url: "https://www.fda.gov/drugs/example" },
    ],
  };
  const parsed = EditorialResearchMaterialSchema.parse(publisher);
  const material = effectiveResearchMaterial({ ...base, excerpt: text, fullText: true, bibliography: normalizeBibliography({ publicationTypes: ["News"] }) }, parsed);
  assert.equal(material.bodyText, publisher.text);
  assert.equal(material.excerpt, null);
  assert.equal(material.fullText, false);
  assert.equal(material.materialKind, "publisher-summary");
  const result = validateAdminResearch({ evidenceStages: [{ value: "clinical", quote: clinicalQuote }] }, material);
  assert.equal(result.profile.basis, "abstract");
  assert.equal(result.profile.materialKind, "publisher-summary");
  assert.equal(result.profile.documentType, "news-policy");
  assert.deepEqual(result.profile.evidenceStages, ["clinical"]);
  assert.equal(result.support["evidenceStages.clinical"], clinicalQuote);
  const publicProfile = withResearchMaterialSources(result.profile, parsed);
  assert.deepEqual(publicProfile.materialSources, publisher.sources);
  assert.ok(!JSON.stringify(publicProfile).includes(clinicalQuote));
  assert.ok(!JSON.stringify(publicProfile).includes(publisher.text));
  assert.ok(!JSON.stringify(publicProfile).includes('"quote"'));
  assert.equal(researchBasisLabel(publicProfile), "基于出版商报道与公开资料");
  assert.equal(researchBasisLabel({ ...publicProfile, basis: "title" }), "仅有标题");
  assert.throws(() => validateAdminResearch({ evidenceStages: [{ value: "animal", quote: "Mice received the study drug in vivo." }] }, material), /来源依据不足/);
});

test("supplemental material supports animal evidence without pretending to be full text", () => {
  const extraction = { evidenceStages: [{ value: "animal", quote: "Mice received the study drug in vivo." }] };
  assert.throws(() => validateAdminResearch(extraction, base), /来源依据不足/);
  const material = effectiveResearchMaterial(base, supplemental);
  const result = validateAdminResearch(extraction, material);
  assert.deepEqual(result.profile.evidenceStages, ["animal"]);
  assert.equal(result.profile.basis, "abstract");
  assert.equal(result.profile.materialKind, "abstract-supplement");
  assert.equal(material.fullText, false);
  assert.equal(researchBasisLabel(result.profile), "基于摘要与补充材料");
  const publicProfile = withResearchMaterialSources(result.profile, supplemental);
  assert.deepEqual(publicProfile.materialSources, sources);
  assert.ok(!JSON.stringify(publicProfile).includes("Mice received"));
  assert.ok(!JSON.stringify(publicProfile).includes('"quote"'));
  assert.equal(base.bodyText, text);
});

test("full text and replacement material determine basis and revalidate stored support", () => {
  const fulltext = { ...supplemental, kind: "fulltext" as const };
  const accepted = validateAdminResearch({ evidenceStages: [{ value: "animal", quote: "Mice received the study drug in vivo." }] }, effectiveResearchMaterial(base, fulltext));
  assert.equal(accepted.profile.basis, "fulltext");
  assert.equal(accepted.profile.materialKind, "fulltext");
  assert.equal(researchBasisLabel(accepted.profile), "基于已获取原文");
  const cleared = validateStoredResearch(accepted.profile, accepted.support, effectiveResearchMaterial(base, null));
  assert.equal(cleared.profile.basis, "abstract");
  assert.deepEqual(cleared.profile.evidenceStages, []);
  assert.equal(cleared.support["evidenceStages.animal"], undefined);
  assert.equal(cleared.rejections["evidenceStages.animal"], "quote-not-in-material");
  const stripped = withResearchMaterialSources(withResearchMaterialSources(accepted.profile, fulltext), null);
  assert.equal(stripped.materialSources, undefined);
  assert.equal(effectiveResearchMaterial(base, null), base);
});
