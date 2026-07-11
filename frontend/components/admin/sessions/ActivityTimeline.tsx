"use client";
import { History } from "lucide-react";
import type { SessionOverviewItem } from "@/lib/types";
import type { AuditRow } from "@/lib/sessions";

function humanize(action: string): string {
  return action.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function relative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function ActivityTimeline({
  session, entries,
}: {
  session: SessionOverviewItem;
  entries: AuditRow[];
}) {
  const fnStem = session.filename.replace(/\.session$/, "");
  const relevant = entries.filter((e) => {
    const t = (e.target || "").toLowerCase();
    return t.includes(session.filename.toLowerCase())
      || t.includes(fnStem.toLowerCase())
      || (!!session.bot_name && t.includes(session.bot_name.toLowerCase()));
  }).slice(0, 30);

  if (relevant.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-dark-500">
        <History className="h-8 w-8 mb-2 opacity-40" />
        <p className="text-sm">No recorded activity for this session yet</p>
        <p className="text-[11px] mt-1">Admin actions on this session appear here</p>
      </div>
    );
  }

  return (
    <ul className="space-y-0 pl-1">
      {relevant.map((e, i) => (
        <li key={i} className="relative flex gap-3 pb-4">
          <div className="flex flex-col items-center">
            <span className="mt-1 h-2 w-2 rounded-full bg-accent shrink-0" />
            {i < relevant.length - 1 && <span className="w-px flex-1 bg-dark-700 mt-1" />}
          </div>
          <div className="min-w-0 -mt-0.5">
            <p className="text-sm text-dark-100">{humanize(e.action)}</p>
            <p className="text-[11px] text-dark-500 truncate">{e.target}</p>
            <p className="text-[11px] text-dark-600">{String(e.admin_id)} · {relative(e.ts)}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
