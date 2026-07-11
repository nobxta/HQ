"use client";
import { useState } from "react";
import useSWR from "swr";
import api from "@/lib/api";
import Card from "@/components/ui/Card";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/Table";
import { TableSkeleton } from "@/components/ui/Skeleton";
import { MessageSquare, RefreshCw, ExternalLink } from "lucide-react";
import { formatDateTime } from "@/lib/utils";

interface DmRow {
  id: string;
  ts: number;
  session_file?: string;
  account_username?: string;
  sender_id?: number;
  sender_name?: string;
  sender_username?: string;
  text?: string;
  media_type?: string;
  caption?: string;
  bot_name?: string;
  bot_username?: string;
  owner_id?: number;
  owner_name?: string;
  owner_email?: string;
}

const fetcher = (url: string) => api.get(url).then((r) => r.data);

export default function AdminDmInboxPage() {
  const [bot, setBot] = useState("");
  const [account, setAccount] = useState("");
  const qs = new URLSearchParams();
  if (bot) qs.set("bot", bot);
  if (account) qs.set("account", account);
  const { data, isLoading, mutate } = useSWR<{ messages: DmRow[]; bots: string[]; accounts: string[] }>(
    `/api/system/dm-inbox${qs.toString() ? `?${qs.toString()}` : ""}`,
    fetcher,
    { refreshInterval: 15000 }
  );

  const rows = data?.messages || [];

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-dark-100">Auto Reply — DM Inbox</h2>
          <p className="text-sm text-dark-400 mt-1">{rows.length} message{rows.length !== 1 ? "s" : ""} across all AdBots</p>
        </div>
        <button onClick={() => mutate()} className="p-2 rounded-lg text-dark-500 hover:text-dark-200 hover:bg-dark-800/50 transition-all" title="Refresh">
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      <div className="flex flex-wrap gap-3">
        <select value={bot} onChange={(e) => setBot(e.target.value)} className="rounded-lg border border-dark-600 bg-dark-800 px-3 py-2 text-sm text-dark-100 focus:outline-none focus:ring-2 focus:ring-accent/40">
          <option value="">All AdBots</option>
          {(data?.bots || []).map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <select value={account} onChange={(e) => setAccount(e.target.value)} className="rounded-lg border border-dark-600 bg-dark-800 px-3 py-2 text-sm text-dark-100 focus:outline-none focus:ring-2 focus:ring-accent/40">
          <option value="">All accounts</option>
          {(data?.accounts || []).map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>

      {isLoading ? (
        <TableSkeleton />
      ) : rows.length === 0 ? (
        <Card className="text-center py-12">
          <MessageSquare className="h-10 w-10 text-dark-600 mx-auto mb-3" />
          <p className="text-dark-400">No DMs received yet</p>
        </Card>
      ) : (
        <Table>
          <Thead>
            <Tr>
              <Th>Time</Th>
              <Th>AdBot</Th>
              <Th>Owner</Th>
              <Th>Account</Th>
              <Th>Sender</Th>
              <Th>Message</Th>
            </Tr>
          </Thead>
          <Tbody>
            {rows.map((r) => (
              <Tr key={r.id}>
                <Td className="whitespace-nowrap text-xs text-dark-400">{formatDateTime(r.ts)}</Td>
                <Td className="text-dark-100">{r.bot_username ? `@${r.bot_username}` : r.bot_name}</Td>
                <Td className="text-xs text-dark-400">
                  {r.owner_name || r.owner_email || (r.owner_id ? `ID ${r.owner_id}` : "—")}
                </Td>
                <Td className="text-xs text-dark-300">{r.account_username ? `@${r.account_username}` : (r.session_file || "—")}</Td>
                <Td className="text-xs">
                  {r.sender_id ? (
                    <a href={`tg://user?id=${r.sender_id}`} className="text-accent hover:underline inline-flex items-center gap-1">
                      {r.sender_name || "Unknown"}{r.sender_username ? ` @${r.sender_username}` : ""}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : (r.sender_name || "Unknown")}
                </Td>
                <Td className="max-w-[320px]">
                  {r.media_type ? (
                    <span className="text-dark-300"><span className="text-dark-500">[{r.media_type}]</span> {r.caption || ""}</span>
                  ) : (
                    <span className="text-dark-200 break-words">{r.text || "—"}</span>
                  )}
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}
    </div>
  );
}
