import { Link, useLocation } from "react-router";
import { SITE } from "@aihot/industry/site";
import { Wordmark } from "../Logo";
import { ThemeSwitch } from "./ThemeSwitch";
export const READER_NAV = [
  { to: "/", label: "导读" }, { to: "/all", label: "资料库" }, { to: "/topics", label: "专题" },
  { to: "/daily", label: "研究简报" }, { to: "/starred", label: "阅读清单" },
];
export function Masthead() {
  const { pathname } = useLocation();
  const active = (to: string) => to === "/" ? pathname === "/" : to === "/daily" ? /^\/(daily|weekly|monthly)(\/|$)/.test(pathname) : pathname === to || pathname.startsWith(to + "/");
  return <header className="journal-masthead">
    <div className="masthead-top">
      <Link to="/" aria-label={`${SITE.name} 首页`}><Wordmark size={32} /><span className="masthead-tagline">中药、天然产物与现代药学的研究阅读索引</span></Link>
      <div className="masthead-utility"><span className="journal-kicker">RESEARCH · EVIDENCE · DISCOVERY</span><Link to="/all?search=1">检索资料 ↗</Link><ThemeSwitch /></div>
      <Link className="mobile-more" to="/more" aria-label="更多功能与外观设置">更多</Link>
    </div>
    <div className="masthead-nav"><nav aria-label="主导航">{READER_NAV.map(n => <Link key={n.to} to={n.to} aria-current={active(n.to) ? "page" : undefined}>{n.label}</Link>)}</nav><span className="journal-kicker">PHARMA RADAR JOURNAL</span></div>
  </header>;
}
export function JournalFooter() {
  return <footer className="journal-footer"><div><strong className="brand-font">Pharma Radar</strong><p>{SITE.footerNote}</p></div><nav aria-label="辅助导航"><Link to="/hot">研究动态</Link><Link to="/about">关于</Link><Link to="/agent">API 与订阅</Link><Link to="/feedback">反馈</Link><Link to="/privacy">隐私</Link><Link to="/terms">使用规则</Link><Link to="/changelog">更新记录</Link></nav></footer>;
}
