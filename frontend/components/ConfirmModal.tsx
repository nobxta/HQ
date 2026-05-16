"use client";
import Modal from "./ui/Modal";
import Button from "./ui/Button";
import { AlertTriangle } from "lucide-react";

interface ConfirmModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  loading?: boolean;
  variant?: "danger" | "primary";
}

export default function ConfirmModal({
  open, onClose, onConfirm, title, message,
  confirmText = "Confirm", loading, variant = "danger",
}: ConfirmModalProps) {
  return (
    <Modal open={open} onClose={onClose} size="sm">
      <div className="flex flex-col items-center text-center gap-4">
        <div className={`p-3 rounded-full ${variant === "danger" ? "bg-danger/10" : "bg-accent/10"}`}>
          <AlertTriangle className={`h-6 w-6 ${variant === "danger" ? "text-danger" : "text-accent"}`} />
        </div>
        <h3 className="text-lg font-semibold text-dark-100">{title}</h3>
        <p className="text-sm text-dark-400">{message}</p>
        <div className="flex gap-3 w-full pt-2">
          <Button variant="secondary" className="flex-1" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button variant={variant === "danger" ? "danger" : "primary"} className="flex-1" onClick={onConfirm} loading={loading}>
            {confirmText}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
