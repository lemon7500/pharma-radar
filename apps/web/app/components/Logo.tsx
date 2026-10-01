// The site's wordmark (its name from industry/site.ts, set in type) and a small ring mark used as the
// loader. A site with its own logo can replace Wordmark here.
import { SITE } from "@aihot/industry/site";

export function Wordmark({ size = 22, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`brand-font inline-flex items-center font-semibold leading-none tracking-[-0.04em] ${className}`} style={{ fontSize: size }} aria-label={SITE.name} role="img">
      <svg aria-hidden="true" viewBox="0 0 32 32" className="mr-2 size-[0.9em] text-accent" fill="none"><path d="M7 25V7h8c7 0 10 9 4 13h-9M21 5l5 5-5 5" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/><path d="M18 24c6-5 8-1 8-1-2 7-7 6-8 1Z" stroke="currentColor" strokeWidth="1.5"/></svg>
      <span aria-hidden="true">{SITE.name}</span>
    </span>
  );
}

/** A ring with a dot; spinning, it is the loader. */
export function RingMark({ className = "", spinning = false }: { className?: string; spinning?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <g style={spinning ? { transformOrigin: "12px 12px", animation: "spin-slow 1.1s linear infinite" } : undefined}>
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeDasharray="42 15" />
      </g>
      <circle cx="12" cy="12" r="2.6" fill="currentColor" />
    </svg>
  );
}
