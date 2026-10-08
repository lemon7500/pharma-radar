// Scope boundaries stay deterministic and free; these checks do not call a model or source.
import assert from "node:assert/strict";
import { test } from "node:test";
import { explicitPharmacyTask, focusSupported, outsidePharmacy, validateResearchExtraction } from "@aihot/backend/research/profile";

test("crop disease, medicinal plants and human food background do not establish a drug task", () => {
  const cases = [
    "Natural products enhance rice resistance to crop disease and bacterial pathogens.",
    "OsPDR17 transports 5,10-diketo-casbene and enhances rice resistance to bacterial blight.",
    // DOI 10.1111/nph.71629: the acquired abstract states the work's purpose, rather than a drug task.
    "These results offered a theoretical insight and an important genetic resource for rice disease resistance research.",
    "Medicinal plants were treated with an antibacterial natural product to protect against plant disease.",
    "We used machine learning to classify crop disease and predict bacterial plant pathogens.",
    "Natural products were evaluated for ecological roles in soil organisms.",
    "Antibacterial natural products improve food preservation. Human patients consumed the preserved food in a clinical study.",
    "We evaluated natural products for crop disease. Future pharmacological applications may be investigated.",
    "We used machine learning to improve crop disease prediction, which could support future drug discovery.",
    "We assessed ecotoxicology and ecological effects of plant compounds in soil organisms.",
    "We evaluated non-pharmacological methods to control crop disease.",
    "We evaluated rice resistance to bacterial blight. Pharmacological properties were not investigated.",
    "Natural products improve food preservation. Previous pharmacological studies are mentioned in the introduction.",
    "Antibacterial therapies were used to control crop disease.",
    "Medicinal plants were studied for crop disease. No pharmaceutical quality-control study was performed.",
  ];
  for (const text of cases) assert.equal(outsidePharmacy(text), true, text);
});

test("explicit pharmaceutical work retains mixed botanical, food and agricultural-source papers", () => {
  const cases = [
    "Plants harvested from agricultural fields were assessed for pharmacological anti-inflammatory effects in cultured macrophages.",
    "Food-derived compounds were evaluated for anticancer drug discovery using cancer cell lines.",
    "We developed antimicrobial drug candidates from crop-associated fungi and evaluated their pharmacokinetics.",
    "We evaluated the quality control of medicinal plants grown under agricultural conditions using their chemical profiles.",
    "Callicarpa nudiflora, a traditional Chinese medicine, was examined for phytochemical quality control. Crop cultivation conditions were recorded.",
    "We assessed drug safety and toxicological effects of natural products recovered from food processing materials.",
    "We tested plant extracts for anti-inflammatory activity that may require further experimental confirmation. The plants were cultivated in agricultural fields.",
    "We tested plant extracts for pharmacological anti-inflammatory effects and found no activity. The plants came from agricultural fields.",
    "We evaluated anticancer activity of crop-derived compounds, but pharmacokinetics were not assessed.",
    "We evaluated the analgesic and antidiabetic activity of plant extracts obtained from agricultural crops in mouse models.",
    "我们采用药理方法验证植物提取物的抗炎作用，并记录药用植物的农业种植环境。",
  ];
  for (const text of cases) {
    assert.equal(explicitPharmacyTask(text), true, text);
    assert.equal(outsidePharmacy(text), false, text);
  }
});

test("unidentified natural compounds and missing purposes are not hard exclusions", () => {
  for (const text of [
    "Isolation and characterization of sclareol from a plant extract.",
    "A natural compound identified in rice.",
    "Machine learning studies of natural products.",
    "Natural products and their chemical structures.",
  ]) assert.equal(outsidePharmacy(text), false, text);
});

test("AI focus requires an actual biomedical task and does not use unrelated pharmacy background", () => {
  const negatives: Array<[string, string]> = [
    ["Crop disease classification", "We used machine learning to classify rice bacterial disease from crop images."],
    ["Clinical drug background and crop images", "We used machine learning to classify crop disease. The introduction discusses anticancer drug discovery."],
    ["Food package identification", "We trained a deep learning model to classify food packaging images."],
    ["General image classification", "We developed a machine learning classifier for everyday photographs and evaluated image classification accuracy."],
    ["Protein interface identification", "We developed ESpma using protein language models and point-cloud features to distinguish biological interfaces from non-biological contacts."],
    ["Protein structure prediction", "We trained a neural network to predict generic protein structures and evaluated structural accuracy on biological benchmarks."],
    ["Drug screening outlook", "Future artificial intelligence may improve drug screening methods."],
    ["Proposed drug screening", "Machine learning models will be trained for drug screening in future studies."],
    ["Drug screening proposal", "We propose that artificial intelligence could be used for drug screening in future studies."],
    ["Drug screening", "We have not used machine learning for drug discovery and instead evaluated conventional screening methods."],
    ["Drug screening", "No machine learning was used for drug discovery in this study; we tested conventional screening methods."],
  ];
  for (const [title, quote] of negatives) assert.equal(focusSupported("ai-pharma", quote, { title, bodyText: quote }), false, quote);
  const positives: Array<[string, string]> = [
    ["AI drug screening", "We used machine learning for drug screening and identified candidate compounds that may require experimental confirmation."],
    ["Therapeutic antibody design", "We used protein language models to design therapeutic antibodies and evaluated their antigen binding properties."],
    ["Pain measurement", "We developed a deep-learning-based algorithm to quantify spontaneous pain behaviours in mice."],
    ["Natural product drug discovery", "We used machine learning and virtual screening to identify natural products."],
  ];
  for (const [title, quote] of positives) assert.equal(focusSupported("ai-pharma", quote, { title, bodyText: quote }), true, quote);
});

test("source-supported agricultural AI does not acquire either pharmaceutical focus", () => {
  const quote = "We used machine learning to classify crop disease and identified natural products that protect rice against bacterial plant pathogens.";
  const result = validateResearchExtraction({ foci: [{ value: "ai-pharma", quote }, { value: "tcm-natural-products", quote }] }, { title: "Natural product crop disease classification", bodyText: quote });
  assert.deepEqual(result.profile.foci, []);
  assert.equal(result.rejections["foci.ai-pharma"], "outside-topic-boundary");
  assert.equal(result.rejections["foci.tcm-natural-products"], "outside-topic-boundary");
});
