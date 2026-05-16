"use client";
import { cn, statusBg } from "@/lib/utils";

interface BadgeProps {
  status: string;
  className?: string;
}

export default function Badge({ status, className }: BadgeProps) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize", statusBg(status), className)}>
      {status}
    </span>
  );
}
