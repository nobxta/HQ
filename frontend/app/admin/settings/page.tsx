"use client";
import { useState, useEffect } from "react";
import { useMaintenance, useWorkers, useAuditLog, useAdminSettings } from "@/lib/hooks/useSettings";
import Card, { CardHeader, CardTitle } from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import Badge from "@/components/ui/Badge";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/Table";
import ConfirmModal from "@/components/ConfirmModal";
import { PageSkeleton } from "@/components/ui/Skeleton";
import {
  Wrench, AlertTriangle, Power, ShieldAlert, Activity, Clock,
  StopCircle, PlayCircle, FolderOpen, Save, Link, RefreshCw, DollarSign,
  ArrowRightLeft,
} from "lucide-react";
import api from "@/lib/api";
import toast from "react-hot-toast";
import { formatDateTime, timeAgo } from "@/lib/utils";

export default function SettingsPage() {
  const { data: maint, mutate: mutateMaint } = useMaintenance();
  const { data: workers } = useWorkers();
  const { data: auditData } = useAuditLog();
  const { data: adminSettings, mutate: mutateSettings } = useAdminSettings();
  const [emergencyConfirm, setEmergencyConfirm] = useState<"stop" | "resume" | null>(null);
  const [maintConfirm, setMaintConfirm] = useState(false);
  const [loading, setLoading] = useState(false);

  // Chatlist links state
  const [chatlistLinks, setChatlistLinks] = useState<{ starter: string[]; enterprise: string[] }>({
    starter: ["", ""],
    enterprise: ["", ""],
  });
  const [savingLinks, setSavingLinks] = useState(false);
  // Replacement settings
  const [repPrice, setRepPrice] = useState<number>(2.0);
  const [savingRepPrice, setSavingRepPrice] = useState(false);
  // Replacement queue
  const [repQueue, setRepQueue] = useState<any>(null);
  const [processingQueue, setProcessingQueue] = useState(false);

  const loadRepQueue = async () => {
    try {
      const res = await api.get("/api/system/replacements");
      setRepQueue(res.data);
    } catch {}
  };

  useEffect(() => {
    if (adminSettings?.chatlist_links) {
      setChatlistLinks({
        starter: adminSettings.chatlist_links.starter || ["", ""],
        enterprise: adminSettings.chatlist_links.enterprise || ["", ""],
      });
    }
    if (adminSettings?.session_replacement_price !== undefined) {
      setRepPrice(adminSettings.session_replacement_price);
    }
  }, [adminSettings]);

  useEffect(() => { loadRepQueue(); }, []);

  const saveRepPrice = async () => {
    setSavingRepPrice(true);
    try {
      await api.put("/api/system/admin-settings", { session_replacement_price: repPrice });
      toast.success("Replacement price saved");
      mutateSettings();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Failed to save");
    }
    setSavingRepPrice(false);
  };

  const processQueue = async () => {
    setProcessingQueue(true);
    try {
      const res = await api.post("/api/system/replacements/process");
      toast.success(`Processed: ${res.data.processed || 0} replacement(s)`);
      loadRepQueue();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Failed to process queue");
    }
    setProcessingQueue(false);
  };

  const saveChatlistLinks = async () => {
    setSavingLinks(true);
    try {
      await api.put("/api/system/admin-settings", { chatlist_links: chatlistLinks });
      toast.success("Chatlist links saved");
      mutateSettings();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Failed to save");
    }
    setSavingLinks(false);
  };

  const updateLink = (mode: "starter" | "enterprise", index: number, value: string) => {
    setChatlistLinks((prev) => {
      const next = { ...prev };
      next[mode] = [...prev[mode]];
      next[mode][index] = value;
      return next;
    });
  };

  const isMaintenanceOn = maint?.maintenance_enabled ?? false;

  const handleEmergency = async (action: "stop" | "resume") => {
    setLoading(true);
    try {
      await api.post(`/api/system/emergency-${action}`);
      toast.success(`Emergency ${action} executed`);
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || `Emergency ${action} failed`);
    }
    setLoading(false);
    setEmergencyConfirm(null);
  };

  const handleMaintenance = async () => {
    setLoading(true);
    try {
      await api.post(`/api/system/maintenance?enabled=${!isMaintenanceOn}`);
      toast.success(isMaintenanceOn ? "Maintenance disabled" : "Maintenance enabled");
      mutateMaint();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Failed");
    }
    setLoading(false);
    setMaintConfirm(false);
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Emergency controls */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="border-danger/30">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 rounded-lg bg-danger/10">
              <StopCircle className="h-5 w-5 text-danger" />
            </div>
            <div>
              <p className="font-medium text-dark-100">Emergency Stop</p>
              <p className="text-xs text-dark-500">Stop ALL bots immediately</p>
            </div>
          </div>
          <Button variant="danger" size="sm" className="w-full" onClick={() => setEmergencyConfirm("stop")}>
            Emergency Stop
          </Button>
        </Card>

        <Card className="border-success/30">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 rounded-lg bg-success/10">
              <PlayCircle className="h-5 w-5 text-success" />
            </div>
            <div>
              <p className="font-medium text-dark-100">Emergency Resume</p>
              <p className="text-xs text-dark-500">Resume all bots</p>
            </div>
          </div>
          <Button variant="success" size="sm" className="w-full" onClick={() => setEmergencyConfirm("resume")}>
            Resume All
          </Button>
        </Card>

        <Card className={isMaintenanceOn ? "border-warning/30" : ""}>
          <div className="flex items-center gap-3 mb-3">
            <div className={`p-2 rounded-lg ${isMaintenanceOn ? "bg-warning/10" : "bg-dark-800"}`}>
              <Wrench className={`h-5 w-5 ${isMaintenanceOn ? "text-warning" : "text-dark-400"}`} />
            </div>
            <div>
              <p className="font-medium text-dark-100">Maintenance Mode</p>
              <p className="text-xs text-dark-500">
                {isMaintenanceOn ? "Currently ON" : "Currently OFF"}
              </p>
            </div>
          </div>
          <Button
            variant={isMaintenanceOn ? "danger" : "secondary"}
            size="sm"
            className="w-full"
            onClick={() => setMaintConfirm(true)}
          >
            {isMaintenanceOn ? "Disable Maintenance" : "Enable Maintenance"}
          </Button>
        </Card>
      </div>

      {/* Default Chatlist Folder Links */}
      <Card>
        <CardHeader>
          <CardTitle><FolderOpen className="h-4 w-4 inline mr-2" />Default Chatlist Folder Links</CardTitle>
        </CardHeader>
        <div className="space-y-5">
          <p className="text-xs text-dark-500">
            Set default Telegram chatlist folder links per plan mode. During bot creation, sessions will auto-join these folders
            and save the group IDs for posting. Up to 2 links per mode.
          </p>

          {(["starter", "enterprise"] as const).map((mode) => (
            <div key={mode} className="space-y-2">
              <p className="text-sm font-medium text-dark-200 capitalize">{mode} Mode</p>
              <div className="space-y-2">
                {[0, 1].map((i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Link className="h-3.5 w-3.5 text-dark-500 shrink-0" />
                    <input
                      className="flex-1 rounded-lg border border-dark-600 bg-dark-950 px-3 py-2 text-sm text-dark-200 font-mono placeholder:text-dark-600 focus:outline-none focus:ring-2 focus:ring-accent/40"
                      placeholder={`https://t.me/addlist/... (link ${i + 1})`}
                      value={chatlistLinks[mode]?.[i] || ""}
                      onChange={(e) => updateLink(mode, i, e.target.value)}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}

          <div className="flex justify-end pt-2 border-t border-dark-800">
            <Button size="sm" onClick={saveChatlistLinks} loading={savingLinks}>
              <Save className="h-3.5 w-3.5" /> Save Links
            </Button>
          </div>
        </div>
      </Card>

      {/* Session Replacement Settings */}
      <Card>
        <CardHeader>
          <CardTitle><DollarSign className="h-4 w-4 inline mr-2" />Session Replacement Pricing</CardTitle>
        </CardHeader>
        <div className="space-y-4">
          <p className="text-xs text-dark-500">
            Price per session replacement when users exceed their free replacement quota.
            Users pay this amount per session to get a new working session from the free pool.
          </p>
          <div className="flex items-end gap-3">
            <div className="space-y-1.5 flex-1 max-w-xs">
              <label className="block text-sm font-medium text-dark-300">Price per Session (USD)</label>
              <input
                type="number"
                step="0.5"
                min="0"
                className="w-full rounded-lg border border-dark-600 bg-dark-950 px-3 py-2 text-sm text-dark-200 focus:outline-none focus:ring-2 focus:ring-accent/40"
                value={repPrice}
                onChange={(e) => setRepPrice(parseFloat(e.target.value) || 0)}
              />
            </div>
            <Button size="sm" onClick={saveRepPrice} loading={savingRepPrice}>
              <Save className="h-3.5 w-3.5" /> Save
            </Button>
          </div>
        </div>
      </Card>

      {/* Replacement Queue */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between w-full">
            <CardTitle><ArrowRightLeft className="h-4 w-4 inline mr-2" />Replacement Queue</CardTitle>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={loadRepQueue}>
                <RefreshCw className="h-3.5 w-3.5" /> Refresh
              </Button>
              {repQueue?.total_awaiting > 0 && (
                <Button size="sm" onClick={processQueue} loading={processingQueue}>
                  Process Queue ({repQueue.total_awaiting})
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        {repQueue ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="rounded-lg border border-dark-700 bg-dark-800/50 p-3 text-center">
                <p className="text-lg font-bold text-dark-100">{repQueue.total_pending}</p>
                <p className="text-xs text-dark-500">Pending</p>
              </div>
              <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-center">
                <p className="text-lg font-bold text-warning">{repQueue.total_awaiting}</p>
                <p className="text-xs text-dark-500">Awaiting Sessions</p>
              </div>
              <div className="rounded-lg border border-dark-700 bg-dark-800/50 p-3 text-center">
                <p className="text-lg font-bold text-dark-100">{repQueue.completed_recent?.length || 0}</p>
                <p className="text-xs text-dark-500">Recently Completed</p>
              </div>
              <div className="rounded-lg border border-dark-700 bg-dark-800/50 p-3 text-center">
                <p className="text-lg font-bold text-dark-100">{repQueue.queue?.filter((e: any) => e.free_replacement).length || 0}</p>
                <p className="text-xs text-dark-500">Free Replacements</p>
              </div>
            </div>

            {(repQueue.queue || []).length > 0 && (
              <Table>
                <Thead>
                  <tr>
                    <Th>Bot</Th>
                    <Th>Session</Th>
                    <Th>Status</Th>
                    <Th>Type</Th>
                    <Th>Spam Status</Th>
                    <Th>Created</Th>
                  </tr>
                </Thead>
                <Tbody>
                  {(repQueue.queue || []).map((e: any) => (
                    <Tr key={e.id}>
                      <Td className="font-medium">{e.bot_name}</Td>
                      <Td className="text-xs font-mono">{e.real_name || e.session_file}</Td>
                      <Td><Badge status={e.status === "ready" ? "active" : e.status === "awaiting_session" ? "waiting" : e.status} /></Td>
                      <Td>{e.free_replacement ? <span className="text-success text-xs font-medium">FREE</span> : <span className="text-xs">${e.price_usd?.toFixed(2)}</span>}</Td>
                      <Td><span className={`text-xs font-medium ${e.spam_status === "FROZEN" ? "text-danger" : e.spam_status === "HARD_LIMITED" ? "text-danger" : "text-warning"}`}>{e.spam_status}</span></Td>
                      <Td className="text-xs">{e.created_at ? new Date(e.created_at).toLocaleDateString() : "—"}</Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            )}

            {(repQueue.queue || []).length === 0 && (
              <p className="text-sm text-dark-500 text-center py-4">No pending replacements</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-dark-500">Loading queue…</p>
        )}
      </Card>

      {/* Workers health */}
      <Card>
        <CardHeader><CardTitle>Worker Health</CardTitle></CardHeader>
        {workers ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Object.entries(workers).map(([name, w]: [string, any]) => (
              <div key={name} className="rounded-lg border border-dark-700 bg-dark-800/50 p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-dark-200">{name}</span>
                  <Badge status={w.healthy ? "active" : "dead"} />
                </div>
                <p className="text-xs text-dark-500">
                  {w.last_heartbeat ? `Last beat: ${timeAgo(w.age_seconds || 0)}` : "No heartbeat"}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-dark-500">No worker data</p>
        )}
      </Card>

      {/* Audit log */}
      <Card>
        <CardHeader><CardTitle>Audit Log</CardTitle></CardHeader>
        <Table>
          <Thead>
            <tr>
              <Th>Time</Th>
              <Th>Action</Th>
              <Th>Detail</Th>
            </tr>
          </Thead>
          <Tbody>
            {(auditData?.entries || []).length === 0 ? (
              <Tr><Td className="text-center py-6 text-dark-500" colSpan={3}>No audit entries</Td></Tr>
            ) : (
              (auditData?.entries || []).slice(0, 30).map((e: any, i: number) => (
                <Tr key={i}>
                  <Td className="text-xs whitespace-nowrap">{formatDateTime(e.ts)}</Td>
                  <Td className="font-medium">{e.action}</Td>
                  <Td className="text-dark-400 max-w-md truncate">{e.detail || "—"}</Td>
                </Tr>
              ))
            )}
          </Tbody>
        </Table>
      </Card>

      {/* Emergency confirm */}
      <ConfirmModal
        open={!!emergencyConfirm}
        onClose={() => setEmergencyConfirm(null)}
        onConfirm={() => emergencyConfirm && handleEmergency(emergencyConfirm)}
        title={emergencyConfirm === "stop" ? "Emergency Stop ALL Bots" : "Resume ALL Bots"}
        message={
          emergencyConfirm === "stop"
            ? "This will immediately stop ALL posting bots. Are you sure?"
            : "This will resume all bots that were emergency-stopped."
        }
        confirmText={emergencyConfirm === "stop" ? "STOP ALL" : "Resume All"}
        variant={emergencyConfirm === "stop" ? "danger" : "primary"}
        loading={loading}
      />

      <ConfirmModal
        open={maintConfirm}
        onClose={() => setMaintConfirm(false)}
        onConfirm={handleMaintenance}
        title={isMaintenanceOn ? "Disable Maintenance" : "Enable Maintenance"}
        message={
          isMaintenanceOn
            ? "Disable maintenance mode? Users will be able to interact with the bot again."
            : "Enable maintenance mode? The shop bot will show a maintenance message to all users."
        }
        confirmText={isMaintenanceOn ? "Disable" : "Enable"}
        variant="primary"
        loading={loading}
      />
    </div>
  );
}
