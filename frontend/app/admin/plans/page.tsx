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
import { Tag, Plus, Edit, Trash2, Save, DollarSign } from "lucide-react";
import api from "@/lib/api";
import toast from "react-hot-toast";
import { useForm } from "react-hook-form";
import { formatUSD } from "@/lib/utils";

export default function PlansPage() {
  const { data, isLoading, mutate } = usePlans();
  const [editPlan, setEditPlan] = useState<any>(null);
  const [editMode, setEditMode] = useState<string | null>(null);
  const [deleteInfo, setDeleteInfo] = useState<{ mode: string; index: number } | null>(null);

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {[1, 2].map((i) => <CardSkeleton key={i} />)}
      </div>
    );
  }

  const allPlans = data || {};
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

  const handleSavePlan = async (plan: any, mode: string, index: number | null) => {
    const updated = { ...allPlans };
    if (!updated[mode]) updated[mode] = [];
    if (index !== null) {
      updated[mode] = [...updated[mode]];
      updated[mode][index] = plan;
    } else {
      updated[mode] = [...updated[mode], plan];
    }
    try {
      await api.put("/api/system/plans", updated);
      toast.success("Plans saved");
      mutate();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Failed to save");
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex gap-3">
        <Button size="sm" onClick={() => { setEditPlan({}); setEditMode("starter"); }}>
          <Plus className="h-4 w-4" /> Add Plan
        </Button>
      </div>

      {modes.length === 0 ? (
        <Card className="text-center py-12">
          <Tag className="h-10 w-10 text-dark-600 mx-auto mb-3" />
          <p className="text-dark-400">No plans configured</p>
        </Card>
      ) : (
        modes.map((mode) => (
          <div key={mode}>
            <h3 className="text-lg font-semibold text-dark-100 mb-4 capitalize flex items-center gap-2">
              <Tag className="h-4 w-4 text-accent" />
              {mode} Plans
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {(allPlans[mode] || []).map((plan: any, idx: number) => (
                <Card key={idx} className="relative">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="font-semibold text-dark-100">{plan.label || plan.name}</h4>
                      <Badge status={mode} />
                    </div>
                    <p className="text-2xl sm:text-3xl font-bold text-accent">{formatUSD(plan.price_usd)}</p>
                    <div className="space-y-1 text-sm text-dark-400">
                      <p>Sessions: {plan.sessions}</p>
                      <p>Cycle: {plan.cycle}s · Gap: {plan.gap}s</p>
                      <p>Duration: {plan.duration_days} days</p>
                      {plan.group_file && <p>Groups: {plan.group_file}</p>}
                    </div>
                    <div className="flex gap-2 pt-2">
                      <Button variant="ghost" size="sm" onClick={() => { setEditPlan({ ...plan, _index: idx }); setEditMode(mode); }}>
                        <Edit className="h-3.5 w-3.5" /> Edit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteInfo({ mode, index: idx })}>
                        <Trash2 className="h-3.5 w-3.5 text-danger" />
                      </Button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        ))
      )}

      {/* Edit/Create modal */}
      {editPlan && editMode && (
        <PlanEditor
          plan={editPlan}
          mode={editMode}
          onClose={() => { setEditPlan(null); setEditMode(null); }}
          onSave={async (plan) => {
            await handleSavePlan(plan, editMode, editPlan._index ?? null);
            setEditPlan(null);
            setEditMode(null);
          }}
        />
      )}

      <ConfirmModal
        open={!!deleteInfo}
        onClose={() => setDeleteInfo(null)}
        onConfirm={handleDelete}
        title="Delete Plan"
        message="Remove this plan? Existing bots on this plan won't be affected."
        confirmText="Delete"
      />
    </div>
  );
}

function PlanEditor({ plan, mode, onClose, onSave }: { plan: any; mode: string; onClose: () => void; onSave: (p: any) => Promise<void> }) {
  const { register, handleSubmit, formState: { errors } } = useForm({
    defaultValues: {
      name: plan.name || "",
      label: plan.label || "",
      sessions: plan.sessions || 3,
      cycle: plan.cycle || 300,
      gap: plan.gap || 5,
      price_usd: plan.price_usd || 0,
      duration_days: plan.duration_days || 30,
      group_file: plan.group_file || "",
    },
  });
  const [loading, setLoading] = useState(false);

  const onSubmit = async (data: any) => {
    setLoading(true);
    await onSave({ ...data, mode });
    setLoading(false);
  };

  return (
    <Modal open onClose={onClose} title={plan._index !== undefined ? "Edit Plan" : "New Plan"} size="md">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Plan Name (key)" error={errors.name?.message as string}
            {...register("name", { required: "Required" })} />
          <Input label="Display Label" {...register("label")} />
          <Input label="Sessions" type="number" {...register("sessions", { valueAsNumber: true, min: 1 })} />
          <Input label="Cycle (sec)" type="number" {...register("cycle", { valueAsNumber: true, min: 60 })} />
          <Input label="Gap (sec)" type="number" {...register("gap", { valueAsNumber: true, min: 1 })} />
          <Input label="Price (USD)" type="number" step="0.01" {...register("price_usd", { valueAsNumber: true })} />
          <Input label="Duration (days)" type="number" {...register("duration_days", { valueAsNumber: true, min: 1 })} />
          <Input label="Group File" placeholder="Starter.txt" {...register("group_file")} />
        </div>
        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" onClick={onClose} type="button">Cancel</Button>
          <Button type="submit" loading={loading}>
            <Save className="h-4 w-4" /> Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}
