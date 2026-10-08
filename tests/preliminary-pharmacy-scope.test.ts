// Pure scope checks: no database, collectors or model requests are involved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { preliminaryAdmission, type PreliminaryInput } from "@aihot/backend/publication/preliminary";
import type { Bibliography } from "@aihot/contracts/research";

const bibliography: Bibliography = {
  doi: "10.1234/pharmacy-scope", pmid: "98765432", journal: "Chinese Medicine", authors: [],
  publishedDate: "2026-10-06", publicationTypes: ["Journal Article"], isPreprint: false,
};
function input(title: string, bodyText?: string): PreliminaryInput {
  return {
    source: { kind: "json_list", participation_mode: "editorial", config: { preliminaryIndex: true, url: "https://www.ebi.ac.uk/europepmc/webservices/rest/search" } },
    article: { url: "https://europepmc.org/article/MED/98765432", title, published_at: new Date("2026-10-06"), bibliography, processing_state: "new", canonical_article_id: null },
    material: { title, bodyText, bibliography }, now: new Date("2026-10-06T12:00:00Z"),
  };
}

test("non-drug therapies and clinical trial labels do not establish pharmacy relevance", () => {
  const cases: Array<[string, string?]> = [
    ["Exercise therapy for postoperative knee pain"],
    ["Psychotherapy for depression: a randomized clinical trial"],
    ["Traditional Chinese medicine acupuncture for chronic pain"],
    ["Non-pharmacological interventions for neck dysfunction"],
    ["Drug-free treatment of postoperative neck pain"],
    ["非药物治疗产后颈部功能障碍"],
    ["A randomized clinical trial of massage for neck dysfunction"],
    ["Clinical and Electromyographic Effect of Tui-Na Massage Versus Positional Release on Postpartum Neck Dysfunction: A Randomized Clinical Trial",
      "Patients received massage treatment and exercise therapy for neck dysfunction. This randomized clinical study compared rehabilitation outcomes."],
    ["Tui-Na massage for neck pain",
      "Pain drugs are commonly used as background treatment. Our randomized study compared massage with positional release for neck dysfunction."],
    ["Tui-Na massage for neck pain",
      "Participants receiving analgesic drugs were excluded. Patients received massage treatment or positional release for neck dysfunction."],
    ["Tui-Na massage for neck pain",
      "No drugs were administered in the randomized intervention. We compared massage and positional release as treatments for neck dysfunction."],
    ["General traditional Chinese medicine treatment", "Clinical trial participants received non-drug treatment for their neck dysfunction."],
    ["Machine learning for exercise therapy"],
  ];
  for (const [title, bodyText] of cases) assert.equal(preliminaryAdmission(input(title, bodyText)), false, title);
});

test("explicit drug and herbal interventions retain access to early bibliographic indexes", () => {
  const cases: Array<[string, string?]> = [
    ["Drug discovery using machine learning"],
    ["Pharmacokinetics of a natural compound"],
    ["Small molecules targeting inflammatory receptors"],
    ["中药方剂的体外抗炎作用"],
    ["Food-derived compounds for anticancer drug discovery"],
    ["Massage versus drug therapy for neck dysfunction"],
    ["Tui-Na massage for neck pain",
      "Participants were randomized to receive oral drugs or massage as the intervention. The study compared pain and electromyographic outcomes."],
    ["Massage for neck pain",
      "Participants received herbal extracts as a treatment for neck dysfunction. The study compared this intervention with massage alone."],
    ["Effects of Chinese herbal medicine on rheumatoid arthritis",
      "Participants received Chinese herbal medicine as a treatment for rheumatoid arthritis. The study assessed pharmacological and inflammatory outcomes."],
    ["Effects of quercetin on inflammatory signaling",
      "The natural compound was evaluated for the treatment of inflammation. The study investigated its anti-inflammatory activity in cell cultures."],
  ];
  for (const [title, bodyText] of cases) assert.equal(preliminaryAdmission(input(title, bodyText)), true, title);
});

test("clinical trials and patients do not loosen agriculture or food-use exclusions", () => {
  const cases: Array<[string, string?]> = [
    ["Natural products for treatment of crop disease"],
    ["Antibacterial natural products protect medicinal plants against crop disease"],
    ["OsPDR17 transports 5,10-diketo-casbene and enhances rice resistance to bacterial blight",
      "We assessed diterpenoid transport in rice and evaluated the resistance of treated plants to bacterial plant pathogens. The study examines crop protection."],
    ["Natural compounds and ecological roles in soil organisms"],
    ["Antibacterial natural products for food preservation",
      "A clinical study in patients examined preserved food consumption. Natural products showed antibacterial activity for food preservation."],
  ];
  for (const [title, bodyText] of cases) assert.equal(preliminaryAdmission(input(title, bodyText)), false, title);
});

test("mixed sources retain explicit drug research and medicinal quality-control indexes", () => {
  for (const [title, bodyText] of [
    ["Pharmacokinetics of antimicrobial drug candidates from crop-associated fungi"],
    ["Quality control of medicinal plants grown in agricultural fields",
      "We evaluated the quality control of medicinal plants using chemical profiles and measured batch composition across agricultural cultivation conditions."],
    ["Drug safety of natural compounds recovered from food processing materials"],
  ] as Array<[string, string?]>) assert.equal(preliminaryAdmission(input(title, bodyText)), true, title);
});
