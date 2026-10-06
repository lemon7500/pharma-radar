# 期刊指标登记与使用

核对日期：2026-10-06。登记表覆盖原始 30 篇样本涉及的 15 本期刊，以及补充临床案例的 1 本期刊。数据保存在 [journal-metrics.json](../industry/journal-metrics.json)，用途是编辑核对与判断卡参考，目前没有接入自动评分、公开 API 或读者页面。

## 已核实的年度指标

以下是来源明确标注年度的两年 Journal Impact Factor（JIF），保留来源的年度表达。未由这些页面独立确认 JCR 发布版本、学科类别、百分位或分区，因此这些字段继续留空，也不产生期刊参考分。

| 期刊 | 来源标注年度 | JIF | 官方出处 |
|---|---:|---:|---|
| European Journal of Pain | 2025 | 3.8 | [European Pain Federation](https://europeanpainfederation.eu/european-journal-of-pain/) |
| Acta Pharmacologica Sinica | 2025 | 10.4 | [出版商期刊信息](https://www.nature.com/aps/journal-information) |
| Nature Reviews Drug Discovery | 2025 | 91.2 | [出版商期刊指标](https://www.nature.com/nrd/journal-impact) |
| Chinese Medicine | 2025 | 7.4 | [出版商期刊主页](https://link.springer.com/journal/13020) |
| Journal of Computer-Aided Molecular Design | 2025 | 3.0 | [出版商期刊主页](https://link.springer.com/journal/10822) |
| Journal of Molecular Modeling | 2025 | 2.9 | [出版商期刊主页](https://link.springer.com/journal/894) |

JIF 是期刊层面的引用指标。这里不按绝对数值跨学科排列单篇论文，也不把它理解为研究可靠度、人体疗效或入选保证。出版商同样提醒 JIF 不能单独代表期刊质量，应结合其他指标与研究内容。[Nature Portfolio 指标说明](https://www.nature.com/nrd/journal-impact)

## 有官方数值，但年度尚未确认

| 期刊 | 页面观察值 | 状态与处理 |
|---|---:|---|
| Protein Science | Impact Factor 5.2 | [Protein Society 首页](https://www.proteinsociety.org/)未标明该数值的数据年度。只保存为未定年观察值，年度 JIF 留空。 |
| Molecular Medicine Reports | Impact Factor 5.0 | [出版商主页](https://www.spandidos-publications.com/mmr)未明确该数值的数据年度。页面的 Q1 是 **CiteScore Rank**，不写成 JCR Q1。 |

网页版权年份、当前期号、核对日期均不能替代指标数据年度。Acta Pharmacologica Sinica 页面另有未标年度的 top-quartile 文案，本轮不据此填入年度 JCR 分区。

## 未取得可核实的年度指标

Biomedical Chromatography、The FASEB Journal、Pharmacology Research & Perspectives、Aging Cell、Journal of Ethnopharmacology、Mini-Reviews in Medicinal Chemistry、Phytochemistry、Diabetes, Obesity and Metabolism 共 8 本，官方指标入口本轮访问受限。期刊身份及 ISSN 依据对应论文的 Europe PMC 元数据登记；指标值、年度和学科位置留空。

Journal of Ethnopharmacology 另核对了 [International Society for Ethnopharmacology 的期刊页](https://ethnopharmacology.org/journal/)，该页未给出年度指标。搜索摘要与第三方聚合数据没有用于填补这些字段。后续若得到可核对的官方公开资料，再增补登记，不要求购买 JCR 或新增付费服务。

## 登记规则

- 用期刊名、已核对别名及 ISSN 识别期刊；论文自己的 DOI 用于文献身份，不把参考文献的期刊映射到本条。
- `verified-dated` 必须有数值、来源明确的年度、官方 URL、核对日期与简短定位引文。`year-unverified` 的观察值与可用年度 JIF 分开存储；`unverified` 不填数值。
- 两年 JIF、五年 JIF、CiteScore、SJR 分别记录，不互换。JCR 类别需要保留类别名称、对应年度及官方来源；多类别不挑最高分来抬高单篇推荐。
- 预印本没有期刊 JIF；监管原始资料的期刊指标不适用。出版商研究简讯仅可关联它自身刊载期刊，不能继承被报道论文的期刊指标或 DOI。监管卡若引用出版商短讯，其期刊数值也不能为 FDA 批准范围提供依据。
- 缺失信息表示尚未核实，不表示期刊影响为零，也不阻止符合要求的资料正常收录。
- 如果将来接入评分或读者页面，须另行实现经核对的身份映射、年度/缺失状态展示，并按[人工标注流程](annotation-protocol.md)验证；这份登记表本身不会改变生产精选。

## 维护与核对

更新登记表后运行 `node scripts/check-editorial-reference.mjs`，检查字段状态、ISSN、年份及文档链接。该检查只验证数据结构和引用完整性；来源内容仍需人工核对。下一次正式校准前复核指标是否更新，不能把“2026-10-06 已核对”当作持续有效保证。

阅读练习见 [12 张基础判断卡](annotation-cards-2026-10-06.md)与[临床、监管补充卡](annotation-cards-additional-2026-10-06.md)。精选标准和线上评分的差异见[人工标注流程](annotation-protocol.md)与[精选说明](selection.md)。
