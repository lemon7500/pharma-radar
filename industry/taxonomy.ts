// 分类 key 是公开 URL 的一部分；主题关键词在 topics.json 中独立管理。
export const CATEGORIES = [
  { key: "tcm", label: "中药", section: "中药与天然产物", guide: "中药、方剂、药用植物、天然产物、活性成分、炮制、质量标准与中药现代化" },
  { key: "ai-pharma", label: "AI制药", section: "AI 药物发现", guide: "AI 药物设计、靶点发现、蛋白结构、分子生成、虚拟筛选与实验验证；通用 AI 新闻不属于此类" },
  { key: "pharmacology", label: "药学", section: "药理与制剂", guide: "药理机制、药代动力学、毒理、制剂、递送、药物分析与药学研究" },
  { key: "clinical", label: "临床", section: "临床与转化", guide: "药物临床试验、研究注册、阶段性结果、适应症、转化研究和药物警戒" },
  { key: "regulation", label: "监管", section: "政策与监管", guide: "药品审批、指导原则、药典标准、监管警示、召回与中医药政策" },
  { key: "industry", label: "产业", section: "产业动态", guide: "制药公司融资、合作、授权、并购、管线与生产变化，必须有具体药物研发或产业信息" },
  { key: "paper", label: "论文", section: "研究方法与论文", guide: "跨领域研究论文、系统综述、药学数据库和方法学；能明确归入中药或 AI 制药的优先归入对应类别" },
  { key: "tip", label: "方法", section: "方法与观点", guide: "可复用的研究方法、工具、实验或数据分析实践" },
  { key: "opinion", label: "观点", section: "方法与观点", guide: "有证据支持的药物研发评论、行业分析与访谈" },
] as const;
export const ITEM_TYPES = ["model_release", "product_launch", "tool_or_prompt", "research_paper", "industry_event", "opinion_analysis", "tutorial_explainer"] as const;
export const CATEGORY_TAGS = ["模型发布", "产品更新", "论文/研究", "临床进展", "政策/监管", "安全/药物警戒", "行业动态", "开源/仓库", "教程/实践", "评测/基准", "观点/分析", "现象/趋势", "其他"] as const;
export const TOPIC_TAGS = ["中药", "天然产物", "药用植物", "方剂", "质量控制", "药理机制", "AI制药", "靶点发现", "分子生成", "蛋白结构", "虚拟筛选", "实验验证", "药代动力学", "毒理", "制剂递送", "临床试验", "创新药", "药物警戒", "研发工具", "数据资源"] as const;
export const ENTITY_TAGS = ["国家药监局", "国家中医药局", "FDA", "EMA", "中国科学院", "Insilico Medicine", "Recursion", "Isomorphic Labs"] as const;
export const TAG_SYNONYMS: Readonly<Record<string, string>> = {
  "AI药物发现": "AI制药", "AI 制药": "AI制药", "AI drug discovery": "AI制药",
  "传统中药": "中药", "中医药": "中药", "中草药": "中药", "natural products": "天然产物",
  "临床研究": "临床试验", "药物安全": "安全/药物警戒",
  "教程/玩法": "教程/实践", "指南": "教程/实践", "教程": "教程/实践", "实践": "教程/实践",
  "开源": "开源/仓库", "仓库": "开源/仓库", "研究": "论文/研究", "论文": "论文/研究",
  "政策": "政策/监管", "监管": "政策/监管", "合作": "行业动态", "融资": "行业动态", "并购": "行业动态",
};
export const CATEGORY_BY_ITEM_TYPE: Readonly<Record<string, string>> = {
  model_release: "模型发布", product_launch: "产品更新", tool_or_prompt: "教程/实践", research_paper: "论文/研究",
  industry_event: "行业动态", opinion_analysis: "观点/分析", tutorial_explainer: "教程/实践",
};
export const ENTITIES: Record<string, { name: string; displayTag: string | null; aliases: string[] }> = {
  nmpa: { name: "国家药监局", displayTag: "国家药监局", aliases: ["国家药监局", "国家药品监督管理局", "NMPA", "CDE"] },
  natcm: { name: "国家中医药局", displayTag: "国家中医药局", aliases: ["国家中医药管理局", "国家中医药局", "NATCM"] },
  fda: { name: "FDA", displayTag: "FDA", aliases: ["FDA", "美国食品药品监督管理局"] },
  ema: { name: "EMA", displayTag: "EMA", aliases: ["EMA", "欧洲药品管理局"] },
  cas: { name: "中国科学院", displayTag: "中国科学院", aliases: ["中国科学院", "Chinese Academy of Sciences"] },
  insilico: { name: "Insilico Medicine", displayTag: "Insilico Medicine", aliases: ["Insilico Medicine", "英矽智能"] },
  recursion: { name: "Recursion", displayTag: "Recursion", aliases: ["Recursion", "Recursion Pharmaceuticals", "Exscientia"] },
  isomorphic: { name: "Isomorphic Labs", displayTag: "Isomorphic Labs", aliases: ["Isomorphic Labs"] },
};
export const IDENTITY_LEXICON: ReadonlyArray<{ id: string; name: string; patterns: RegExp[] }> = [
  { id: "nmpa", name: "国家药监局", patterns: [/国家药监局|国家药品监督管理局|\bNMPA\b|\bCDE\b/i] },
  { id: "natcm", name: "国家中医药局", patterns: [/国家中医药管理局|国家中医药局|\bNATCM\b/i] },
  { id: "fda", name: "FDA", patterns: [/\bFDA\b|美国食品药品监督管理局/i] },
  { id: "ema", name: "EMA", patterns: [/\bEMA\b|欧洲药品管理局/i] },
  { id: "cas", name: "中国科学院", patterns: [/中国科学院|Chinese Academy of Sciences/i] },
  { id: "insilico", name: "Insilico Medicine", patterns: [/Insilico Medicine|英矽智能/i] },
  { id: "recursion", name: "Recursion", patterns: [/\bRecursion\b|\bExscientia\b/i] },
  { id: "isomorphic", name: "Isomorphic Labs", patterns: [/Isomorphic Labs/i] },
];
export const PUBLISHER_DOMAINS: ReadonlyArray<{ entityId: string; domains: readonly string[] }> = [
  { entityId: "nmpa", domains: ["nmpa.gov.cn", "cde.org.cn"] },
  { entityId: "natcm", domains: ["natcm.gov.cn"] },
  { entityId: "fda", domains: ["fda.gov"] },
  { entityId: "ema", domains: ["ema.europa.eu"] },
  { entityId: "cas", domains: ["cas.cn"] },
  { entityId: "insilico", domains: ["insilico.com"] },
  { entityId: "recursion", domains: ["recursion.com"] },
  { entityId: "isomorphic", domains: ["isomorphiclabs.com"] },
];
export const IDENTITY_CONTEXT_ALIASES: ReadonlyArray<{ entityId: string; pattern: RegExp }> = [];
