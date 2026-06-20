"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import portalApi, { setPortalSession } from "@/lib/portal-api";
import { Loader2, Send, CheckCheck } from "lucide-react";

const STEPS = [
  "Assigning sessions",
  "Creating log group",
  "Configuring groups",
  "Setting up web panel",
  "Finalizing",
];

export default function ProvisioningPage() {
  const router = useRouter();
  const [botName, setBotName] = useState("");
  const [step, setStep] = useState("");
  const [idx, setIdx] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let code = "";
    try {
      const raw = localStorage.getItem("portal_provisioning");
      if (raw) { const p = JSON.parse(raw); code = p.code || ""; setBotName(p.bot_name || ""); }
    } catch { /* ignore */ }
    if (!code) { router.replace("/login"); return; }

    const poll = async () => {
      try {
        const { data } = await portalApi.post("/api/portal/unified-login", { code });
        if (data.role === "user" && !data.provisioning) {
          // Bot is ready — upgrade to the real session and go to the dashboard.
          setPortalSession({
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            bot_name: data.bot_name,
            telegram_id: data.telegram_id,
          });
          try { localStorage.removeItem("portal_provisioning"); } catch {}
          if (pollRef.current) clearInterval(pollRef.current);
          router.replace("/user/dashboard");
          return;
        }
        if (data.creation_step) setStep(data.creation_step);
        if (data.bot_name) setBotName(data.bot_name);
      } catch { /* keep waiting; bot not ready / transient */ }
    };
    poll();
    pollRef.current = setInterval(poll, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [router]);

  // gentle visual progress
  useEffect(() => {
    const iv = setInterval(() => setIdx(i => Math.min(i + 1, STEPS.length - 1)), 1600);
    return () => clearInterval(iv);
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-dark-950 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-dark-700/50 bg-dark-850 p-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/15 border border-accent/20 mx-auto mb-4">
          <Send className="h-6 w-6 text-accent" />
        </div>
        <h1 className="text-lg font-bold text-white">Setting up your AdBot</h1>
        <p className="text-sm text-dark-400 mt-1">
          {botName ? <>&ldquo;{botName}&rdquo; is being created.</> : "Your bot is being created."} This usually takes about a minute — you can keep this page open.
        </p>

        <div className="mt-5 rounded-xl border border-dark-700/40 bg-dark-900 p-4 space-y-2.5 text-left">
          {STEPS.map((s, i) => {
            const state = i < idx ? "done" : i === idx ? "active" : "todo";
            return (
              <div key={s} className="flex items-center gap-2.5">
                {state === "done" ? <CheckCheck className="w-4 h-4 text-accent" />
                  : state === "active" ? <Loader2 className="w-4 h-4 text-accent animate-spin" />
                  : <span className="w-4 h-4 rounded-full border border-dark-700 inline-block" />}
                <span className={`text-[13px] ${state === "todo" ? "text-dark-600" : "text-dark-200"}`}>{s}</span>
              </div>
            );
          })}
          {step && (
            <div className="pt-2 mt-1 border-t border-dark-700/40 flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 text-accent animate-spin flex-shrink-0" />
              <span className="text-[12px] text-dark-400 truncate">{step}</span>
            </div>
          )}
        </div>

        <p className="text-[11px] text-dark-600 mt-4">We&apos;ll take you to your dashboard automatically when it&apos;s ready.</p>
      </div>
    </div>
  );
}
