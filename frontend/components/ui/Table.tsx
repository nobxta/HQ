"use client";
import { cn } from "@/lib/utils";
import { ReactNode } from "react";

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-x-auto -mx-4 sm:mx-0 rounded-none sm:rounded-xl border-y sm:border border-dark-700/50", className)}>
      <table className="w-full text-sm min-w-[500px]">{children}</table>
    </div>
  );
}

export function Thead({ children }: { children: ReactNode }) {
  return <thead className="border-b border-dark-700 bg-dark-850">{children}</thead>;
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <th className={cn("px-3 sm:px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-dark-400 whitespace-nowrap", className)}>
      {children}
    </th>
  );
}

export function Tbody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-dark-700/50">{children}</tbody>;
}

export function Tr({ children, className, onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  return (
    <tr className={cn("bg-dark-900 hover:bg-dark-800/50 transition-colors", onClick && "cursor-pointer", className)} onClick={onClick}>
      {children}
    </tr>
  );
}

export function Td({ children, className, colSpan }: { children?: ReactNode; className?: string; colSpan?: number }) {
  return <td className={cn("px-3 sm:px-4 py-3 text-dark-200", className)} colSpan={colSpan}>{children}</td>;
}
