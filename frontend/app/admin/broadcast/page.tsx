"use client";
import { useState } from "react";
import Card, { CardHeader, CardTitle } from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import ConfirmModal from "@/components/ConfirmModal";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/Table";
import { Megaphone, Send, Users } from "lucide-react";
import api from "@/lib/api";
import toast from "react-hot-toast";
import useSWR from "swr";
import { formatDateTime } from "@/lib/utils";

const fetcher = (url: string) => api.get(url).then((r) => r.data);

export default function BroadcastPage() {
  const { data: segments } = useSWR("/api/broadcast/segments", fetcher);
  const { data: history } = useSWR("/api/broadcast/history", fetcher);
  const [selectedSegment, setSelectedSegment] = useState("all_users");
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [loading, setLoading] = useState(false);

  const segMap = segments?.segments || {};

  const handleSend = async () => {
    setLoading(true);
    try {
      const { data } = await api.post("/api/broadcast/send", { segment: selectedSegment, text: message });
      toast.success(`Broadcast sent: ${data.sent} delivered, ${data.failed} failed`);
      setMessage("");
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Broadcast failed");
    }
    setLoading(false);
    setConfirm(false);
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Compose */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Compose Broadcast</CardTitle></CardHeader>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-dark-300">Segment</label>
                <select
                  value={selectedSegment}
                  onChange={(e) => setSelectedSegment(e.target.value)}
                  className="w-full rounded-lg border border-dark-600 bg-dark-800 px-3 py-2 text-sm text-dark-100 focus:outline-none focus:ring-2 focus:ring-accent/40"
                >
                  {Object.entries(segMap).map(([k, v]: [string, any]) => (
                    <option key={k} value={k}>{k} ({v} users)</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-dark-300">Message</label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  className="w-full h-40 rounded-lg border border-dark-600 bg-dark-950 px-4 py-3 text-sm text-dark-200 focus:outline-none focus:ring-2 focus:ring-accent/40 resize-none"
                  placeholder="Type your broadcast message…"
                />
              </div>
              <Button onClick={() => setConfirm(true)} disabled={!message.trim()}>
                <Send className="h-4 w-4" /> Send Broadcast
              </Button>
            </div>
          </Card>
        </div>

        {/* Segments */}
        <Card>
          <CardHeader><CardTitle>Segments</CardTitle></CardHeader>
          <div className="space-y-2">
            {Object.entries(segMap).map(([k, v]: [string, any]) => (
              <div key={k} className="flex items-center justify-between rounded-lg bg-dark-800/50 px-3 py-2">
                <span className="text-sm text-dark-300 flex items-center gap-2">
                  <Users className="h-3.5 w-3.5 text-accent" />
                  {k}
                </span>
                <span className="text-sm font-medium text-dark-100">{v}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* History */}
      <Card>
        <CardHeader><CardTitle>Broadcast History</CardTitle></CardHeader>
        <Table>
          <Thead>
            <tr>
              <Th>Date</Th>
              <Th>Segment</Th>
              <Th>Sent</Th>
              <Th>Failed</Th>
              <Th>Message</Th>
            </tr>
          </Thead>
          <Tbody>
            {(history?.history || []).length === 0 ? (
              <Tr><Td className="text-center py-6 text-dark-500" colSpan={5}>No broadcasts yet</Td></Tr>
            ) : (
              (history?.history || []).map((h: any, i: number) => (
                <Tr key={i}>
                  <Td className="text-xs">{formatDateTime(h.ts)}</Td>
                  <Td>{h.segment}</Td>
                  <Td className="text-success">{h.sent}</Td>
                  <Td className="text-danger">{h.failed}</Td>
                  <Td className="max-w-xs truncate text-dark-400">{h.text}</Td>
                </Tr>
              ))
            )}
          </Tbody>
        </Table>
      </Card>

      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={handleSend}
        title="Send Broadcast"
        message={`Send this message to "${selectedSegment}" (${segMap[selectedSegment] || 0} users)?`}
        confirmText="Send"
        variant="primary"
        loading={loading}
      />
    </div>
  );
}
