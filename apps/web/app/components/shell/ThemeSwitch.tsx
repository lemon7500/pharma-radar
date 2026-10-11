import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconMonitor, IconMoon, IconSun } from "../icons";
import { resolvedTheme, setThemePreference, useThemePreference, type ThemePreference } from "../../lib/local-state";

type Choice = "dark" | "system" | "light";

const OPTIONS: Array<{ key: Choice; label: string; icon: ReactNode }> = [
  { key: "dark", label: "深色", icon: <IconMoon size={14} /> },
  { key: "system", label: "跟随系统", icon: <IconMonitor size={14} /> },
  { key: "light", label: "浅色", icon: <IconSun size={14} /> },
];

/** Three-way appearance switch (dark / follow the system / light) with a sliding thumb. */
export function ThemeSwitch({ className = "" }: { className?: string }) {
  const pref = useThemePreference();
  const [mounted, setMounted] = useState(false);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => setMounted(true), []);
  const current: Choice = !mounted ? "system" : (pref ?? "system");
  const index = OPTIONS.findIndex((o) => o.key === current);

  const choose = (key: Choice) => {
    const nextPref: ThemePreference = key === "system" ? null : key;
    const apply = () => {
      setThemePreference(nextPref);
      document.documentElement.setAttribute("data-theme", resolvedTheme(nextPref));
    };
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    if (doc.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) doc.startViewTransition(apply);
    else apply();
  };

  return (
    <div role="radiogroup" aria-label="外观" className={`relative grid h-[52px] min-w-[140px] shrink-0 grid-cols-3 rounded-full border border-line bg-bg-sunk p-[3px] ${className}`}>
      <span
        aria-hidden="true"
        className="absolute inset-y-[3px] left-[3px] w-[calc((100%-6px)/3)] rounded-full border border-line bg-surface shadow-[var(--shadow-card)] transition-transform duration-200 ease-[var(--ease-out-quart)]"
        style={{ transform: `translateX(${index * 100}%)` }}
      />
      {OPTIONS.map((o, optionIndex) => (
        <button
          key={o.key}
          ref={element => { buttons.current[optionIndex] = element; }}
          type="button"
          role="radio"
          aria-checked={current === o.key}
          tabIndex={current === o.key ? 0 : -1}
          title={o.label}
          onClick={() => choose(o.key)}
          onKeyDown={event => {
            let nextIndex: number;
            if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (optionIndex + 1) % OPTIONS.length;
            else if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (optionIndex - 1 + OPTIONS.length) % OPTIONS.length;
            else if (event.key === "Home") nextIndex = 0;
            else if (event.key === "End") nextIndex = OPTIONS.length - 1;
            else return;
            event.preventDefault();
            choose(OPTIONS[nextIndex]!.key);
            buttons.current[nextIndex]?.focus();
          }}
          className={`relative z-10 flex items-center justify-center rounded-full transition-colors duration-150 ${current === o.key ? "text-ink" : "text-ink-4 hover:text-ink-2"}`}
        >
          {o.icon}
          <span className="sr-only">{o.label}</span>
        </button>
      ))}
    </div>
  );
}
