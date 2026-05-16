"use client";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import { ReactNode, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
  size?: "sm" | "md" | "lg" | "xl";
}

const sizeMap: Record<string, string> = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
};

export default function Modal({ open, onClose, title, children, className, size = "md" }: ModalProps) {
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
      const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
      window.addEventListener("keydown", handler);
      return () => { window.removeEventListener("keydown", handler); document.body.style.overflow = ""; };
    }
    document.body.style.overflow = "";
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 40 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className={cn(
              "relative w-full rounded-t-2xl sm:rounded-xl border border-dark-700 bg-dark-900 shadow-2xl max-h-[90vh] overflow-y-auto",
              sizeMap[size],
              className
            )}
          >
            {title && (
              <div className="sticky top-0 z-10 flex items-center justify-between border-b border-dark-700 px-4 sm:px-6 py-4 bg-dark-900">
                <h2 className="text-base sm:text-lg font-semibold text-dark-100">{title}</h2>
                <button onClick={onClose} className="text-dark-400 hover:text-dark-200 transition-colors p-1">
                  <X className="h-5 w-5" />
                </button>
              </div>
            )}
            <div className="p-4 sm:p-6">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
