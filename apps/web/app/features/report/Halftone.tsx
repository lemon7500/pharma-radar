import type { ReactNode } from "react";
/** Plain journal typography, preserving the report component's existing API. */
export function Halftone({ className = "", children }: { seed: string; className?: string; children: ReactNode }) {
  return <span className={className}>{children}</span>;
}
