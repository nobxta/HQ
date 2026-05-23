"use client";
import { useState } from "react";
import { usePlans } from "@/lib/hooks/usePlans";
import Card, { CardHeader, CardTitle } from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Modal from "@/components/ui/Modal";
import ConfirmModal from "@/components/ConfirmModal";
import { CardSkeleton } from "@/components/ui/Skeleton";
import Badge from "@/components/ui/Badge";
import {
  Tag, Plus, Edit, Trash2, Save, Users, Clock, Timer,
  DollarSign, Calendar, ChevronRight, Zap, Shield,
} from "lucide-react";
import api from "@/lib/api";
import toast from "react-hot-toast";
import { useForm } from "react-hook-form";
import { formatUSD } from "@/lib/utils";

interface PlanData {
  id: string;
  sessions: number;
  cycle: number;
  gap: number;
  price_week: number;
  price_month: number;
  group_file?: string;
  free_replacements: number;
}

function formatCycle(sec: number): string {
  if (!sec) return "—";
  if (sec >= 3600) return `${(sec / 3600).toFixed(sec % 3600 === 0 ? 0 : 1)}h`;
  if (sec >= 60) return `${Math.round(sec / 60)}m`;
  return `${sec}s`;
}

function savingsPercent(week: number, month: number): number | null {
  if (!week || !month) return null;
  const monthFromWeekly = week * 4;
  if (monthFromWeekly <= month) return null;
  return Math.round(((monthFromWeekly - month) / monthFromWeekly) * 100);
}

export default function PlansPage() {
  const { data, isLoading, mutate } = usePlans();
  const [editPlan, setEditPlan] = useState<(PlanData & { _index?: number }) | null>(null);
  const [editMode, setEditMode] = useState<string | null>(null);
  const [addMode, setAddMode] = useState<string | null>(null);
  const [deleteInfo, setDeleteInfo] = useState<{ mode: string; index: number; id: string } | null>(null);

  if (isLoading) {
    return (
      <div className="space-y-8">
        {[1, 2].map((i) => <CardSkeleton key={i} />)}
      </div>
    );
  }

  const allPlans: Record<string, PlanData[]> = data || {};
  const modes = Object.keys(allPlans);

  const handleDelete = async () => {
    if (!deleteInfo) return;
    const updated = { ...allPlans };
    updated[deleteInfo.mode] = [...updated[deleteInfo.mode]];
    updated[deleteInfo.mode].splice(deleteInfo.index, 1);
    try {
      await api.put("/api/system/plans", updated);
      toast.success("Plan deleted");
      mutate();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Failed to delete plan");
    }
    setDeleteInfo(null);
  };

  const handleSavePlan = async (plan: PlanData, mode: string, index: number | null) => {
    const updated = { ...allPlans };
    if (!updated[mode]) updated[mode] = [];
    const cleanPlan: PlanData = {
      id: plan.id,
      sessions: plan.sessions,
      cycle: plan.cycle,
      gap: plan.gap,
      price_week: plan.price_week,
      price_month: plan.price_month,
      free_replacements: plan.free_replacements ?? 0,
      ...(plan.group_file ? { group_file: plan.group_file } : {}),
    };
    if (index !== null) {
      updated[mode] = [...updated[mode]];
      updated[mode][index] = cleanPlan;
    } else {
      updated[mode] = [...updated[mode], cleanPlan];
    }
    try {
      await api.put("/api/system/plans", updated);
      toast.success(index !== null ? "Plan updated" : "Plan added");
      mutate();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Failed to save");
    }
  };

  const modeIcons: Record<string, typeof Zap> = { starter: Zap, enterprise: Shield };

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-dark-100">Pricing Plans</h2>
          <p className="text-sm text-dark-400 mt-1">
            {modes.reduce((sum, m) => sum + (allPlans[m]?.length || 0), 0)} plans across {modes.length} modes
          </p>
        </div>
      </div>

      {modes.length === 0 ? (
        <Card className="text-center py-12">
          <Tag className="h-10 w-10 text-dark-600 mx-auto mb-3" />
          <p className="text-dark-400">No plans configured</p>
        </Card>
      ) : (
        modes.map((mode) => {
          const ModeIcon = modeIcons[mode] || Tag;
          const plans = allPlans[mode] || [];
          return (
            <div key={mode} className="space-y-4">
              {/* Mode header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-accent/10">
                    <ModeIcon className="h-4 w-4 text-accent" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-dark-100 capitalize">{mode}</h3>
                    <p className="text-xs text-dark-500">{plans.length} plan{plans.length !== 1 ? "s" : ""}</p>
                  </div>
                </div>
                <Button size="sm" variant="secondary" onClick={() => { setAddMode(mode); setEditPlan({ id: "", sessions: 3, cycle: 300, gap: 5, price_week: 0, price_month: 0, free_replacements: 2 }); setEditMode(mode); }}>
                  <Plus className="h-3.5 w-3.5" /> Add
                </Button>
              </div>

              {/* Plan cards grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
                {plans.map((plan, idx) => {
                  const savings = savingsPercent(plan.price_week, plan.price_month);
                  return (
                    <Card key={plan.id || idx} className="relative group hover:border-dark-500 transition-colors">
                      <div className="space-y-4">
                        {/* Plan name + badge */}
                        <div className="flex items-start justify-between">
                          <div>
                            <h4 className="text-base font-bold text-dark-100 uppercase tracking-wide">{plan.id}</h4>
                            <Badge status={mode} className="mt-1" />
                          </div>
                          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={() => { setEditPlan({ ...plan, _index: idx }); setEditMode(mode); setAddMode(null); }}
                              className="p-1.5 rounded-md hover:bg-dark-700 text-dark-400 hover:text-dark-200 transition-colors"
                            >
                              <Edit className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => setDeleteInfo({ mode, index: idx, id: plan.id })}
                              className="p-1.5 rounded-md hover:bg-danger/10 text-dark-400 hover:text-danger transition-colors"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>

                        {/* Pricing */}
                        <div className="space-y-2">
                          <div className="flex items-baseline gap-2">
                            <span className="text-2xl font-bold text-accent">{formatUSD(plan.price_week)}</span>
                            <span className="text-sm text-dark-500">/week</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-lg font-semibold text-dark-200">{formatUSD(plan.price_month)}</span>
                            <span className="text-sm text-dark-500">/month</span>
                            {savings !== null && (
                              <span className="text-xs font-medium text-success bg-success/10 px-1.5 py-0.5 rounded">
                                Save {savings}%
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Stats row */}
                        <div className="grid grid-cols-4 gap-2 pt-2 border-t border-dark-700/50">
                          <div className="text-center">
                            <div className="flex items-center justify-center gap-1 text-dark-400 mb-0.5">
                              <Users className="h-3 w-3" />
                            </div>
                            <p className="text-sm font-semibold text-dark-100">{plan.sessions}</p>
                            <p className="text-[10px] text-dark-500 uppercase tracking-wider">Sessions</p>
                          </div>
                          <div className="text-center">
                            <div className="flex items-center justify-center gap-1 text-dark-400 mb-0.5">
                              <Clock className="h-3 w-3" />
                            </div>
                            <p className="text-sm font-semibold text-dark-100">{formatCycle(plan.cycle)}</p>
                            <p className="text-[10px] text-dark-500 uppercase tracking-wider">Cycle</p>
                          </div>
                          <div className="text-center">
                            <div className="flex items-center justify-center gap-1 text-dark-400 mb-0.5">
                              <Timer className="h-3 w-3" />
                            </div>
                            <p className="text-sm font-semibold text-dark-100">{plan.gap}s</p>
                            <p className="text-[10px] text-dark-500 uppercase tracking-wider">Gap</p>
                          </div>
                          <div className="text-center">
                            <div className="flex items-center justify-center gap-1 text-dark-400 mb-0.5">
                              <Shield className="h-3 w-3" />
                            </div>
                            <p className="text-sm font-semibold text-dark-100">
                              {plan.free_replacements < 0 ? "∞" : plan.free_replacements || 0}
                            </p>
                            <p className="text-[10px] text-dark-500 uppercase tracking-wider">Free Rep.</p>
                          </div>
                        </div>

                        {plan.group_file && (
                          <p className="text-xs text-dark-500 truncate">Groups: {plan.group_file}</p>
                        )}
                      </div>
                    </Card>
                  );
                })}
              </div>
            </div>
          );
        })
      )}

      {/* Edit/Create modal */}
      {editPlan && editMode && (
        <PlanEditor
          plan={editPlan}
          mode={editMode}
          isNew={addMode !== null || editPlan._index === undefined}
          existingIds={
            (allPlans[editMode] || [])
              .map((p, i) => (i !== editPlan._index ? p.id : ""))
              .filter(Boolean)
          }
          onClose={() => { setEditPlan(null); setEditMode(null); setAddMode(null); }}
          onSave={async (plan) => {
            await handleSavePlan(plan, editMode, editPlan._index ?? null);
            setEditPlan(null);
            setEditMode(null);
            setAddMode(null);
          }}
        />
      )}

      <ConfirmModal
        open={!!deleteInfo}
        onClose={() => setDeleteInfo(null)}
        onConfirm={handleDelete}
        title="Delete Plan"
        message={`Remove "${deleteInfo?.id}" plan? Existing bots on this plan won't be affected.`}
        confirmText="Delete"
      />
    </div>
  );
}

function PlanEditor({
  plan,
  mode,
  isNew,
  existingIds,
  onClose,
  onSave,
}: {
  plan: PlanData & { _index?: number };
  mode: string;
  isNew: boolean;
  existingIds: string[];
  onClose: () => void;
  onSave: (p: PlanData) => Promise<void>;
}) {
  const { register, handleSubmit, watch, formState: { errors } } = useForm({
    defaultValues: {
      id: plan.id || "",
      sessions: plan.sessions || 3,
      cycle: plan.cycle || 300,
      gap: plan.gap || 5,
      price_week: plan.price_week || 0,
      price_month: plan.price_month || 0,
      group_file: plan.group_file || "",
      free_replacements: plan.free_replacements ?? 2,
    },
  });
  const [loading, setLoading] = useState(false);

  const pw = watch("price_week");
  const pm = watch("price_month");
  const savings = savingsPercent(pw, pm);

  const onSubmit = async (data: any) => {
    setLoading(true);
    await onSave(data);
    setLoading(false);
  };

  return (
    <Modal open onClose={onClose} title={isNew ? `New ${mode} Plan` : `Edit "${plan.id}"`} size="md">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        {/* Plan ID */}
        <Input
          label="Plan ID"
          placeholder="e.g. bronze, silver, gold"
          error={errors.id?.message as string}
          disabled={!isNew}
          {...register("id", {
            required: "Plan ID is required",
            pattern: { value: /^[a-z0-9_-]+$/, message: "Lowercase letters, numbers, hyphens, underscores only" },
            validate: (v) => !existingIds.includes(v) || "A plan with this ID already exists",
          })}
        />

        {/* Performance settings */}
        <div>
          <p className="text-sm font-medium text-dark-300 mb-3">Performance</p>
          <div className="grid grid-cols-3 gap-3">
            <Input label="Sessions" type="number" {...register("sessions", { valueAsNumber: true, min: { value: 1, message: "Min 1" } })} error={errors.sessions?.message as string} />
            <Input label="Cycle (sec)" type="number" {...register("cycle", { valueAsNumber: true, min: { value: 30, message: "Min 30s" } })} error={errors.cycle?.message as string} />
            <Input label="Gap (sec)" type="number" {...register("gap", { valueAsNumber: true, min: { value: 1, message: "Min 1" } })} error={errors.gap?.message as string} />
          </div>
        </div>

        {/* Pricing */}
        <div>
          <p className="text-sm font-medium text-dark-300 mb-3">Pricing (USD)</p>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Weekly Price" type="number" step="0.01" {...register("price_week", { valueAsNumber: true, min: 0 })} error={errors.price_week?.message as string} />
            <Input label="Monthly Price" type="number" step="0.01" {...register("price_month", { valueAsNumber: true, min: 0 })} error={errors.price_month?.message as string} />
          </div>
          {savings !== null && (
            <p className="text-xs text-success mt-2">Monthly saves {savings}% vs weekly billing</p>
          )}
        </div>

        {/* Replacements */}
        <div>
          <p className="text-sm font-medium text-dark-300 mb-3">Session Replacements</p>
          <Input
            label="Free Replacements per Renewal (-1 = unlimited)"
            type="number"
            {...register("free_replacements", { valueAsNumber: true })}
            error={errors.free_replacements?.message as string}
          />
          <p className="text-xs text-dark-500 mt-1">How many free session replacements users get per billing period. 0 = none, -1 = unlimited.</p>
        </div>

        {/* Optional */}
        <Input label="Group File (optional)" placeholder="Starter.txt" {...register("group_file")} />

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" onClick={onClose} type="button">Cancel</Button>
          <Button type="submit" loading={loading}>
            <Save className="h-4 w-4" /> {isNew ? "Create" : "Save Changes"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
