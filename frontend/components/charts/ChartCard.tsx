import { ReactNode } from "react";

export function ChartCard({ children, title, subtitle, action, className = "" }: {
  children: ReactNode;
  title: string;
  subtitle?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`relative rounded-[18px] overflow-hidden p-5 flex flex-col ${className}`}
      style={{
        background: "linear-gradient(135deg,#171722 0%,#141420 100%)",
        border: "1px solid rgba(255,255,255,0.06)",
        boxShadow: "0 4px 24px rgba(0,0,0,0.4),inset 0 1px 0 rgba(255,255,255,0.05)",
      }}
    >
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h3 className="text-[15px] font-semibold text-hq-text leading-tight">{title}</h3>
          {subtitle && <p className="text-[12px] text-hq-muted mt-1 leading-tight">{subtitle}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="flex-1 min-h-0 flex flex-col">{children}</div>
    </div>
  );
}
