// 站点身份和读者看得到的文案。换成你的行业时，先改这个文件。
// 网页和后端都读它；改完重新构建（docker compose up --build）即可生效。
// 域名不在这里：部署时用环境变量 SITE_URL 设置。

export const SITE = {
  /** 站名：导航、页面标题、分享图、RSS、MCP、后台都用它。 */
  name: "药研雷达",
  /**
   * 行业词：拼进默认说法里，比如“AI 日报”“AI 动态”。
   * 改成“法律”“HR”“黄金”之类，页面上就会变成“法律日报”“法律动态”。
   */
  subject: "药研",
  /** 首页的完整标题（浏览器标签、搜索结果）。 */
  homeTitle: "药研雷达 — 中药 · AI制药 · 药学动态",
  /** 一句话介绍：搜索引擎、分享卡片、RSS、llms.txt 会用。 */
  description: "追踪中药与天然产物、AI 药物发现和药学研究，聚合可追溯的中文摘要、主题索引与日报。",
  /** 首页左上角和侧边栏下面的一行小字。 */
  tagline: "从天然产物到 AI 制药",
  /** 界面语言（HTML lang、og:locale）。 */
  locale: "zh-CN",
  /** 默认域名，只在没设置 SITE_URL 时使用。 */
  defaultUrl: "http://localhost:3000",
  /**
   * MCP 工具名的前缀（小写字母、数字、下划线），工具会叫 myhot_get_latest、myhot_search……
   * 已经有人接入后就不要再改。
   */
  mcpPrefix: "pharma_radar",
  /** 对外联系邮箱（选填）：使用规则、llms.txt、响应头里会写。 */
  contactEmail: "Lemon7500@163.com" as string | null,
  /** 页脚的一行小字（选填）。 */
  footerNote: "研究动态与阅读索引 · 重要结论请核对原文",
  /** 中国大陆网站的 ICP 备案号（选填），填了就显示在页脚并链接到工信部备案系统。 */
  icp: null as string | null,
  /** 结构化数据里的网站运营者（搜索引擎用）。 */
  organization: {
    name: "药研雷达",
    /** 创始人（选填）：{ name, url, description }。 */
    founder: { name: "Lemon" } as null | { name: string; url?: string; description?: string },
  },
  /** 抓取信源时报上的名字（User-Agent 里用），不要冒用别的站。 */
  crawlerName: "PharmaRadarBot",
} as const;

/** 关于页的文案。数字（信源数、收录数、精选数、日报期数）来自站内实时统计，不用写在这里。 */
export const ABOUT = {
  kicker: `关于 ${SITE.name}`,
  /** 大标题：第一行正常颜色，第二行强调色。 */
  headline: ["从草木到算法，", "追踪有证据的药物研发进展。"] as [string, string],
  /** 标题下面的一段话。{sources} 会换成实时的信源数。 */
  lead: `${SITE.name} 替你盯着 {sources} 个信源：抓取、归并、打分、精选，定时整理研究动态和日报，免费托管的执行时间可能延迟。免费，不用注册。`,
  /** 信源河动画下面的四个环节。 */
  steps: {
    collect: "跟踪公开期刊订阅和研究数据库，中药与 AI 制药关键词分开管理，初始按小时检查。",
    store: "抓到的都存下来，同一件事的报道归到一起；只计入热度的账号也算在内，热点榜就是从这里算出来的。",
    select: "模型检查药学相关性和实际信息，再写中文标题、摘要和推荐理由；尽量压低营销和重复转发内容。",
    publish: "整理日报、周报和月报，通过网页、RSS、API 与 MCP 提供摘要和原文链接。",
  },
  /**
   * 作者块（选填），null 就不显示。
   * avatarSourceId：一个 X 账号信源的 id，头像取它的（选填）。
   * 二维码在后台“设置”里上传，或者放进 industry/brand/contact/；没有二维码就不显示那张卡片。
   */
  maker: null as null | {
    name: string;
    greeting: string[];
    avatarSourceId?: string | null;
    wechat?: { title: string; note: string };
    feishu?: { title: string; note: string };
  },
  /** 页面底部的版权与下架说明（结尾会接“反馈页”的链接）。 */
  copyright: `${SITE.name} 是聚合摘要和阅读索引，原文版权归各来源所有。如果你是来源方，希望更正、下架或调整展示方式，可以通过`,
} as const;

export const TOPIC_PAGE = {
  title: "按主题看药研",
  description: "按研究方向、机构与资料类型追踪中药、天然产物、AI 制药和药学进展。",
  groups: [
    { key: "company", name: "机构与企业", blurb: "按研究机构和制药企业追踪具体进展" },
    { key: "field", name: "研究方向", blurb: "中药、天然产物、AI 制药、药理、制剂与临床" },
    { key: "genre", name: "资料与证据", blurb: "政策监管、原始研究、综述与研发工具" },
  ],
} as const;

/** “AI 日报”这类说法：行业词和名词之间，英文词加空格，中文词不加。 */
export function withSubject(noun: string): string {
  return /[A-Za-z0-9]$/.test(SITE.subject) ? `${SITE.subject} ${noun}` : `${SITE.subject}${noun}`;
}
