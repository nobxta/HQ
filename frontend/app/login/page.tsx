"use client";
import { useState, useEffect } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Key, Loader2, Eye, EyeOff } from "lucide-react";
import BrandMark from "@/components/BrandMark";
import portalApi, { setPortalSession } from "@/lib/portal-api";
import BackendSwitcher from "@/components/BackendSwitcher";
import { getApiBase } from "@/lib/api-base";
import { Suspense } from "react";

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [code, setCode] = useState("");
  const [showCode, setShowCode] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [autoLogging, setAutoLogging] = useState(false);

  useEffect(() => {
    const urlToken = searchParams.get("token");
    if (urlToken) {
      setAutoLogging(true);
      loginWithCode(urlToken);
    }
  }, [searchParams]);

  const loginWithCode = async (inputCode: string) => {
    const trimmed = inputCode.trim();
    if (!trimmed) { setError("Enter your access code"); return; }

    setError("");
    setLoading(true);

    try {
      const { data } = await portalApi.post("/api/portal/unified-login", { code: trimmed });

      if (data.role === "admin") {
        // Admin → sign in via next-auth (sets session cookie for middleware)
        const result = await signIn("credentials", {
          redirect: false,
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          api_base: getApiBase(),
        });
        if (result?.error) {
          setError("Admin login failed");
          setLoading(false);
          setAutoLogging(false);
        } else {
          router.push("/admin");
        }
      } else {
        // User → store portal session
        setPortalSession({
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          bot_name: data.bot_name,
          telegram_id: data.telegram_id,
        });
        if (data.provisioning) {
          // Bot still being built → work-in-progress page (keeps the code to re-check)
          try { localStorage.setItem("portal_provisioning", JSON.stringify({ code: trimmed, bot_name: data.bot_name })); } catch {}
          router.replace("/user/provisioning");
        } else {
          router.replace("/user/dashboard");
        }
      }
    } catch (e: any) {
      setError(e?.response?.data?.detail || "Invalid code");
      setAutoLogging(false);
      setLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    loginWithCode(code);
  };

  if (autoLogging) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0a0a0a] p-4 font-sans">
        <div className="text-center space-y-4">
          <BrandMark height={36} className="mx-auto" />
          <div className="flex items-center justify-center gap-2 text-[#8b8b93]">
            <Loader2 className="h-4 w-4 animate-spin" style={{ color: "#2AABEE" }} />
            <span className="text-sm">Signing in…</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0a0a0a] p-4 font-sans">
      <div className="w-full max-w-sm space-y-6">
        {/* Logo */}
        <div className="flex flex-col items-center">
          <BrandMark height={40} className="mb-4" />
          <p className="text-sm text-[#8b8b93] mt-1">Enter your access code to continue</p>
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-lg bg-danger/10 border border-danger/20 px-3 py-2">
            <p className="text-sm text-danger">{error}</p>
          </div>
        )}

        {/* Login form */}
        <form
          onSubmit={handleSubmit}
          className="rounded-xl border border-[#1f1f22] bg-[#0e0e10] p-5 sm:p-6 space-y-4"
        >
          <div>
            <label htmlFor="code" className="block text-xs font-medium text-[#8b8b93] mb-1.5">
              Access Code
            </label>
            <div className="relative">
              <input
                id="code"
                type={showCode ? "text" : "password"}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Enter code"
                autoFocus
                autoComplete="off"
                className="w-full rounded-lg border border-[#1f1f22] bg-[#0a0a0a] px-3 py-2.5 pr-10 text-sm text-white placeholder:text-[#5d5d66] focus:outline-none focus:border-[#2AABEE]/60 focus:ring-2 focus:ring-[#2AABEE]/30 transition-all"
              />
              <button
                type="button"
                onClick={() => setShowCode(!showCode)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[#5d5d66] hover:text-[#8b8b93] transition-colors"
              >
                {showCode ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110 disabled:opacity-60"
            style={{ background: "#2AABEE" }}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Key className="h-4 w-4" />}
            Sign In
          </button>

          <p className="text-[10px] text-[#5d5d66] text-center">
            Your access code was provided when your bot was created.
          </p>
        </form>

        {/* Local-dev only: pick which backend to authenticate + test against.
            Renders nothing on the live domain. */}
        <BackendSwitcher />
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center bg-[#0a0a0a]">
        <Loader2 className="h-6 w-6 animate-spin" style={{ color: "#2AABEE" }} />
      </div>
    }>
      <LoginContent />
    </Suspense>
  );
}
