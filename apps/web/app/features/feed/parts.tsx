// Small building blocks shared by feed items, detail pages and lists.
import { useState } from "react";
import type { FeedItemSummary, MediaView } from "@aihot/contracts/site";
import { IconBookmark } from "../../components/icons";
import { SourceAvatar } from "../../components/ui/SourceAvatar";
import { Lightbox } from "../../components/ui/Lightbox";
import { toggleStar, useIsStarred } from "../../lib/local-state";

/** "IT之家（RSS）" or, for X, avatar + display name + @handle. */
export function SourceLine({ item, avatarSize = 16, className = "" }: { item: Pick<FeedItemSummary, "source" | "x" | "channel">; avatarSize?: number; className?: string }) {
  if (item.channel === "x" && item.x) {
    return (
      <span className={`flex min-w-0 items-center gap-1.5 ${className}`}>
        <SourceAvatar name={item.x.authorName} avatarUrl={item.x.avatarUrl} avatarSrcSet={item.x.avatarSrcSet} size={avatarSize} />
        <span className="truncate text-ink-3">{item.x.authorName}</span>
        <span className="hidden shrink-0 text-ink-4 min-[400px]:inline">@{item.x.handle}</span>
      </span>
    );
  }
  return <span className={`min-w-0 truncate ${className}`}>{item.source.name}</span>;
}

/** Up to four media thumbnails, kept small in lists (the detail page shows them larger). Videos are stills. */
export function MediaThumbs({ media, className = "" }: { media: MediaView[]; className?: string }) {
  const [index, setIndex] = useState<number | null>(null);
  const images = media.filter((m) => m.kind === "image").map((m) => ({ src: m.fullUrl ?? m.url, alt: m.alt }));
  const shown = media.slice(0, 4);
  if (shown.length === 0) return null;
  return (
    <>
    <div className={`flex gap-1.5 overflow-hidden ${className}`}>
      {shown.map((m) => {
        const Wrapper = m.kind === "image" ? "button" : "span";
        return (
        <Wrapper key={m.url} {...(m.kind === "image" ? { type: "button" as const, "aria-label": `查看图片${m.alt ? `：${m.alt}` : ""}`, onClick: (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); setIndex(images.findIndex((image) => image.src === (m.fullUrl ?? m.url))); } } : {})} className={`relative ${m.kind === "image" ? "z-10 cursor-zoom-in" : ""} shrink-0 overflow-hidden rounded-control border border-line-soft bg-bg-sunk ${shown.length === 1 ? "max-w-[240px]" : "w-[112px]"}`}>
          <img src={m.poster ?? m.url} srcSet={m.srcSet} sizes={shown.length === 1 ? `${m.width && m.height ? Math.min(240, Math.ceil(112 * m.width / m.height)) : 240}px` : "112px"} width={m.width ?? undefined} height={m.height ?? undefined} alt={m.alt ?? ""} loading="lazy" decoding="async" className={`h-[112px] object-cover ${shown.length === 1 ? "w-auto max-w-[240px]" : "w-[112px]"}`} />
          {m.kind === "video" && (
            <span className="absolute inset-0 grid place-items-center" aria-hidden="true">
              <span className="grid size-8 place-items-center rounded-full bg-black/55 text-white">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className="ml-px">
                  <path d="M7 4.5v15a1 1 0 001.5.87l13-7.5a1 1 0 000-1.74l-13-7.5A1 1 0 007 4.5z" />
                </svg>
              </span>
            </span>
          )}
        </Wrapper>
      ); })}
    </div>
    <Lightbox images={images} index={index} onIndex={setIndex} onClose={() => setIndex(null)} />
    </>
  );
}

/** Bookmark toggle kept in this browser (收藏). */
export function StarButton({ item, size = 26, className = "" }: { item: Pick<FeedItemSummary, "id" | "title" | "summary" | "source" | "publishedAt" | "score" | "selected"> & Partial<Pick<FeedItemSummary,"publicationTime">>; size?: number; className?: string }) {
  const starred = useIsStarred(item.id);
  const [pulse, setPulse] = useState(0);
  const [storageError, setStorageError] = useState(false);
  const on = starred;
  return (
    <><button
      type="button"
      aria-pressed={on}
      aria-label={on ? "取消收藏" : "收藏"}
      title={on ? "取消收藏" : "收藏"}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const added = toggleStar({
          id: item.id, title: item.title, summary: item.summary, sourceName: item.source.name,
          publishedAt: item.publishedAt, score: item.score, aiSelected: item.selected,
          ...(item.publicationTime?.precision === "day" ? {publishedDate:item.publicationTime.date} : {}),
          ...(item.publicationTime ? {publicationTime:item.publicationTime} : {}),
        });
        setStorageError(added === null);
        if (added === true) setPulse((p) => p + 1);
      }}
      style={{ width: Math.max(44, size), height: Math.max(44, size) }}
      className={`relative z-10 inline-flex shrink-0 items-center justify-center rounded-control transition-colors duration-150 ${on ? "text-accent" : "text-ink-4 hover:bg-bg-sunk hover:text-ink-2"} ${className}`}
    >
      <span key={pulse} className={`flex ${pulse ? "anim-bump" : ""}`}>
        <IconBookmark size={Math.round(size * 0.6)} filled={on} />
      </span>
    </button>
    {storageError && <div role="alert" className="fixed bottom-[calc(80px+env(safe-area-inset-bottom))] left-4 right-4 z-[70] mx-auto flex max-w-md items-center gap-3 rounded-tile border border-line bg-surface px-4 py-3 text-[13px] text-hot shadow-[var(--shadow-pop)] lg:bottom-6">
      <p className="flex-1">浏览器存储已满或不可用，收藏状态未能保存。请检查浏览器存储后重试。</p>
      <button type="button" aria-label="关闭收藏错误提示" onClick={() => setStorageError(false)} className="min-h-11 shrink-0 px-2">关闭</button>
    </div>}</>
  );
}
