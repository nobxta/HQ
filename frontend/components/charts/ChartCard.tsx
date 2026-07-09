"use client";
import type { ReactNode } from "react";

/* Shared card shell for Overview analytics — compact header + content slot. */
export default function ChartCard({ title, subtitle, right, children, className = "" }: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-[16px] border border-hq-border bg-hq-card p-4 sm:p-5 transition-colors hover:border-white/[0.12] animate-fade-in ${className}`}>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold text-hq-text leading-tight">{title}</h3>
          {subtitle && <p className="text-[12px] text-hq-muted mt-0.5 truncate">{subtitle}</p>}
        </div>
        {right && <div className="shrink-0">{right}</div>}
      </div>
      {children}
    </div>
  );
}
