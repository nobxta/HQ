"use client";
import { useState, useRef } from "react";
import { useGroups, useGroupFile } from "@/lib/hooks/useGroups";
import Card, { CardHeader, CardTitle } from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Modal from "@/components/ui/Modal";
import ConfirmModal from "@/components/ConfirmModal";
import { CardSkeleton } from "@/components/ui/Skeleton";
import { FolderOpen, Plus, Trash2, Edit, Upload, Save, FileText } from "lucide-react";
import api from "@/lib/api";
import toast from "react-hot-toast";
import { useForm } from "react-hook-form";

export default function GroupsPage() {
  const { data, isLoading, mutate } = useGroups();
  const [editFile, setEditFile] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const groups = data?.groups || [];

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const form = new FormData();
    form.append("file", file);
    try {
      await api.post("/api/groups/upload", form, { headers: { "Content-Type": "multipart/form-data" } });
      toast.success(`Uploaded ${file.name}`);
      mutate();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Upload failed");
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.delete(`/api/groups/${encodeURIComponent(deleteTarget)}`);
      toast.success(`Deleted ${deleteTarget}`);
      mutate();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Delete failed");
    }
    setDeleteTarget(null);
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4" /> Create
        </Button>
        <div>
          <input ref={fileRef} type="file" accept=".txt" className="hidden" onChange={handleUpload} />
          <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()} loading={uploading}>
            <Upload className="h-4 w-4" /> Upload .txt
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => <CardSkeleton key={i} />)}
        </div>
      ) : groups.length === 0 ? (
        <Card className="text-center py-12">
          <FolderOpen className="h-10 w-10 text-dark-600 mx-auto mb-3" />
          <p className="text-dark-400">No group files yet</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {groups.map((g) => (
            <Card key={g.filename} hover onClick={() => setEditFile(g.filename)}>
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-accent/10">
                    <FileText className="h-5 w-5 text-accent" />
                  </div>
                  <div>
                    <p className="font-medium text-dark-100">{g.filename}</p>
                    <p className="text-xs text-dark-500">{g.lines} groups</p>
                  </div>
                </div>
                <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                  <Button variant="ghost" size="sm" onClick={() => setEditFile(g.filename)}>
                    <Edit className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(g.filename)}>
                    <Trash2 className="h-3.5 w-3.5 text-danger" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Editor modal */}
      {editFile && (
        <GroupEditor filename={editFile} onClose={() => setEditFile(null)} onSaved={() => { setEditFile(null); mutate(); }} />
      )}

      {/* Create modal */}
      <CreateGroupModal open={showCreate} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); mutate(); }} />

      <ConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete Group File"
        message={`Delete "${deleteTarget}"? Bots using this file will fail on next cycle.`}
        confirmText="Delete"
      />
    </div>
  );
}

function GroupEditor({ filename, onClose, onSaved }: { filename: string; onClose: () => void; onSaved: () => void }) {
  const { data } = useGroupFile(filename);
  const [content, setContent] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const text = content ?? data?.content ?? "";
  const lineCount = text.split("\n").filter(Boolean).length;

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.put(`/api/groups/${encodeURIComponent(filename)}`, { filename, content: text });
      toast.success(`Saved ${filename} (${lineCount} groups)`);
      onSaved();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Save failed");
    }
    setSaving(false);
  };

  return (
    <Modal open onClose={onClose} title={`Edit: ${filename}`} size="xl">
      <div className="space-y-3">
        <div className="flex items-center justify-between text-xs text-dark-500">
          <span>{lineCount} groups</span>
          <span>One group per line: -1001234567890 or -1001234567890 | 34</span>
        </div>
        <textarea
          className="w-full h-96 rounded-lg border border-dark-600 bg-dark-950 px-4 py-3 text-sm text-dark-200 font-mono focus:outline-none focus:ring-2 focus:ring-accent/40 resize-none"
          value={text}
          onChange={(e) => setContent(e.target.value)}
          spellCheck={false}
          placeholder="-1001234567890&#10;-1001234567891 | 5"
        />
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} loading={saving}>
            <Save className="h-4 w-4" /> Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function CreateGroupModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { register, handleSubmit, formState: { errors } } = useForm<{ filename: string; content: string }>();
  const [loading, setLoading] = useState(false);

  const onSubmit = async (data: { filename: string; content: string }) => {
    setLoading(true);
    try {
      await api.post("/api/groups", data);
      toast.success(`Created ${data.filename}`);
      onCreated();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || "Create failed");
    }
    setLoading(false);
  };

  return (
    <Modal open={open} onClose={onClose} title="Create Group File" size="lg">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <Input label="Filename" placeholder="MyGroups.txt" error={errors.filename?.message}
          {...register("filename", { required: "Required" })} />
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-dark-300">Groups</label>
          <textarea
            className="w-full h-48 rounded-lg border border-dark-600 bg-dark-950 px-4 py-3 text-sm text-dark-200 font-mono focus:outline-none focus:ring-2 focus:ring-accent/40 resize-none"
            placeholder="-1001234567890&#10;-1001234567891 | 5"
            {...register("content", { required: "Required" })}
          />
          {errors.content && <p className="text-xs text-danger">{errors.content.message}</p>}
        </div>
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose} type="button">Cancel</Button>
          <Button type="submit" loading={loading}>Create</Button>
        </div>
      </form>
    </Modal>
  );
}
