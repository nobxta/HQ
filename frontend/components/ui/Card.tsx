"use client";
import { cn } from "@/lib/utils";
import { ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
  hover?: boolean;
  onClick?: () => void;
}

export default function Card({ children, className, hover, onClick }: CardProps) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "rounded-xl border border-dark-700/50 bg-dark-850 p-4 sm:p-5",
        hover && "cursor-pointer hover:border-accent/30 hover:bg-dark-800 transition-all duration-200 active:scale-[0.98]",
        className
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between mb-4 gap-2", className)}>
      {children}
    </div>
  );
}

export function CardTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h3 className={cn("text-base sm:text-lg font-semibold text-dark-100", className)}>{children}</h3>;
}
