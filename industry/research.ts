// Research facets are independent. The legacy category vocabulary remains an external identity.
export const RESEARCH_AREAS = [
  { key: "discovery", label: "药物发现", description: "活性物质、靶点、筛选与分子设计" },
  { key: "mechanisms", label: "药理机制", description: "作用机制、药效与安全性" },
  { key: "formulation-pk", label: "制剂与药代", description: "剂型、递送、药代与药效关系" },
  { key: "translation", label: "临床转化", description: "临床研究、转化与药物应用" },
] as const;
export const RESEARCH_FOCI = [
  { key: "tcm-natural-products", label: "中药与天然产物", description: "从药用植物、方剂到活性成分与现代药学" },
  { key: "ai-pharma", label: "AI 药物研发", description: "计算方法、数据与实验相结合的药物发现" },
] as const;
export const DOCUMENT_TYPES = [
  { key: "original-research", label: "原始研究" }, { key: "review", label: "综述" },
  { key: "methods-resources", label: "方法与资源" }, { key: "commentary", label: "评论" },
  { key: "news-policy", label: "监管与产业资讯" },
] as const;
export const EVIDENCE_STAGES = [
  { key: "computational", label: "计算" }, { key: "in-vitro", label: "体外" },
  { key: "animal", label: "动物" }, { key: "clinical", label: "临床" },
] as const;
export const SOURCE_ORIGINS = [
  { key: "primary", label: "原始资料" }, { key: "secondary", label: "二次报道" }, { key: "unknown", label: "待确认" },
] as const;
export const RESEARCH_CLAIMS = [
  { key: "object", label: "研究对象" }, { key: "question", label: "研究问题" },
  { key: "methods", label: "研究方法" }, { key: "results", label: "核心结果" },
  { key: "limitations", label: "研究局限" },
] as const;
