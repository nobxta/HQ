"use client";
import { useRouter } from "next/navigation";
import { Lock, RefreshCw, ShieldCheck, Clock } from "lucide-react";

interface ExpiredGateProps {
  /** Whether the plan is expired (server-authoritative `expired` flag). */
  expired: boolean;
  /** Hours left in the 48h grace window before the bot is removed. null = not yet tracked. */
  graceHoursLeft?: number | null;
}

/**
 * Full-screen, branded blur-lock shown over the portal when the plan has expired. It is UX only —
 * the real enforcement is server-side (expired bots reject start/config with 403). The layout hides
 * this on /user/billing so the renewal wizard stays reachable.
 */
export default function ExpiredGate({ expired, graceHoursLeft }: ExpiredGateProps) {
  const router = useRouter();
  if (!expired) return null;

  const hrs = typeof graceHoursLeft === "number" ? graceHoursLeft : null;
  const inGrace = hrs !== null && hrs > 0;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6">
      {/* Heavy scrim + blur over the whole portal */}
      <div className="absolute inset-0 bg-dark-950/80 backdrop-blur-xl" aria-hidden />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Plan expired"
        className="relative w-full max-w-[420px] overflow-hidden rounded-[28px] border border-white/[0.08] bg-[#0C0D14] shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9)] animate-fade-in"
      >
        {/* Accent header band */}
        <div className="relative h-24 overflow-hidden border-b border-white/[0.06] bg-gradient-to-br from-accent/25 via-accent/10 to-transparent">
          <div className="pointer-events-none absolute -right-10 -top-16 h-40 w-40 rounded-full bg-accent/25 blur-[60px]" />
          <div className="pointer-events-none absolute -bottom-16 left-6 h-32 w-32 rounded-full bg-danger/15 blur-[60px]" />
          <div className="absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.06] backdrop-blur-md">
            <Lock className="h-7 w-7 text-white" />
          </div>
        </div>

        <div className="px-6 pb-6 pt-6 text-center sm:px-7">
          {inGrace ? (
            <>
              <h2 className="text-[22px] font-black tracking-tight text-white">Your AdBot plan has expired</h2>
              <p className="mx-auto mt-2 max-w-[320px] text-sm leading-relaxed text-dark-300">
                Posting has been paused, and dashboard access is temporarily locked. Renew your plan to
                bring your AdBot back online with the same accounts and settings.
              </p>

              <div className="mt-5 flex items-center justify-center gap-2.5 rounded-2xl border border-warning/20 bg-warning/[0.07] px-4 py-3">
                <Clock className="h-4 w-4 shrink-0 text-warning" />
                <p className="text-[13px] font-semibold text-warning">
                  <span className="tabular-nums text-white">{hrs}h remaining</span> before your AdBot is
                  permanently removed
                </p>
              </div>

              <button
                onClick={() => router.push("/user/billing/renew")}
                className="mt-5 inline-flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-accent text-[15px] font-bold text-white shadow-lg shadow-accent/25 transition-all hover:bg-accent-600 active:scale-[0.99]"
              >
                <RefreshCw className="h-4 w-4" />
                Renew Plan
              </button>

              {/* Reassurance — nothing is lost during grace */}
              <div className="mt-4 flex items-center justify-center gap-2 text-[12px] text-dark-400">
                <ShieldCheck className="h-3.5 w-3.5 text-success/70" />
                <span>Your accounts and settings will remain safe during the grace period.</span>
              </div>
            </>
          ) : (
            <>
              <h2 className="text-[22px] font-black tracking-tight text-white">Your AdBot can no longer be restored</h2>
              <p className="mx-auto mt-2 max-w-[320px] text-sm leading-relaxed text-dark-300">
                The 48-hour renewal period has ended, and your AdBot is being removed.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
