"use client";
import { useState, useEffect } from "react";
import useSWR from "swr";
import api from "@/lib/api";
import Card, { CardHeader, CardTitle } from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/Table";
import { TableSkeleton } from "@/components/ui/Skeleton";
import { MessageSquare, RefreshCw, ExternalLink, Lock, Save, RotateCcw } from "lucide-react";
import { formatDateTime } from "@/lib/utils";
import toast from "react-hot-toast";

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

  // Admin-managed footer appended to every auto-reply.
  const { data: footerData, mutate: mutateFooter } = useSWR<{ footer: string; default: string }>(
    "/api/system/dm-inbox/footer",
    fetcher
  );
  const [footer, setFooter] = useState("");
  const [savingFooter, setSavingFooter] = useState(false);
  useEffect(() => {
    if (footerData?.footer !== undefined) setFooter(footerData.footer);
  }, [footerData?.footer]);

  const saveFooter = async () => {
    setSavingFooter(true);
    try {
      await api.put("/api/system/dm-inbox/footer", { footer });
      toast.success("Footer saved");
      mutateFooter();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Failed to save footer");
    }
    setSavingFooter(false);
  };

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

      {/* Locked footer — appended to every auto-reply; only admins can edit it */}
      <Card>
        <CardHeader>
          <CardTitle><Lock className="h-4 w-4 inline mr-2" />Auto-Reply Footer</CardTitle>
          {footerData?.default !== undefined && footer !== footerData.default && (
            <button onClick={() => setFooter(footerData.default)} className="text-xs text-dark-500 hover:text-dark-200 inline-flex items-center gap-1">
              <RotateCcw className="h-3 w-3" /> Reset to default
            </button>
          )}
        </CardHeader>
        <p className="text-xs text-dark-400 mb-3">
          This text is automatically added after every user&apos;s auto-reply message (two lines below it).
          Users can write their own message but can never edit or remove this footer — only you can.
        </p>
        <textarea
          className="w-full h-24 rounded-lg border border-dark-600 bg-dark-950 px-3 py-2.5 text-sm text-dark-200 focus:outline-none focus:ring-2 focus:ring-accent/40 resize-none"
          value={footer}
          onChange={(e) => setFooter(e.target.value)}
          placeholder={footerData?.default || "For HQAdz AdBot, visit @HQAdz…"}
        />
        <div className="flex justify-end mt-3">
          <Button onClick={saveFooter} loading={savingFooter} size="sm"><Save className="h-4 w-4" /> Save Footer</Button>
        </div>
      </Card>

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
                  <div className="flex flex-col gap-1 items-start">
                    <span className="text-dark-100 font-medium">{r.sender_name || "Unknown"}</span>
                    {r.sender_username && <span className="text-dark-500">@{r.sender_username}</span>}
                    {r.sender_id ? (
                      <a href={`tg://user?id=${r.sender_id}`} className="inline-flex items-center gap-1 rounded-md bg-accent/10 text-accent px-2 py-0.5 hover:bg-accent/20 transition-colors" title="Open sender profile">
                        ID {r.sender_id} <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : null}
                  </div>
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
