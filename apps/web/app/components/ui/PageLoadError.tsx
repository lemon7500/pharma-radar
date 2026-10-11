import { Link } from "react-router";
import { RingMark } from "../Logo";
import { buttonClass } from "./Controls";

export function currentPageRetryHref(pathname: string, search: string) {
  if (!pathname.startsWith("/") || pathname.startsWith("//") || /[\\?#\u0000-\u0020]/.test(pathname)) return "/";
  if ((search && !search.startsWith("?")) || /[#\u0000-\u0020]/.test(search)) return pathname;
  return pathname + search;
}

export function PageLoadError({ status, retryHref }: { status: number; retryHref: string }) {
  const notFound = status === 404;
  return <div className="flex min-h-[70vh] items-center justify-center px-2 py-16">
    <div className="max-w-sm text-center">
      <RingMark className="mx-auto mb-5 size-10 text-accent" />
      <div className="mono text-[12px] text-ink-4">{status}</div>
      <h1 className="mt-1.5 text-[20px] font-bold text-ink">{notFound ? "这里没有内容" : "暂时无法加载"}</h1>
      <p className="mt-2 text-[13.5px] leading-relaxed text-ink-3">
        {notFound ? "你访问的页面不存在，或内容已不再公开。" : "本页暂时无法加载，请稍后重新加载此页。保存在当前浏览器的收藏不会因服务加载失败而被删除。"}
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2.5">
        {!notFound && <Link to={retryHref} reloadDocument className={buttonClass("primary")}>重新加载此页</Link>}
        <Link to="/" className={buttonClass(notFound ? "primary" : "secondary")}>回到导读</Link>
        <Link to="/all" className={buttonClass("secondary")}>浏览资料库</Link>
      </div>
    </div>
  </div>;
}
