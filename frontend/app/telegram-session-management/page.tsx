import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

export const metadata: Metadata = {
  title: "Telegram Session Management | HQAdz.io",
  description: "Learn how HQAdz handles Telegram session management automatically. Our system manages proxies, accounts, and flood wait handling to ensure optimal account health.",
  alternates: { canonical: "https://hqadz.io/telegram-session-management" },
};

export default function SessionManagementPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#8b8b93] py-32 px-6">
      <div className="max-w-3xl mx-auto space-y-12">
        <header className="space-y-4">
          <h1 className="text-4xl md:text-5xl font-semibold text-white">Telegram Session Management</h1>
          <p className="text-lg">Reliable infrastructure for your Telegram advertising bot campaigns.</p>
        </header>

        <section className="space-y-6">
          <h2 className="text-2xl font-medium text-white">The Challenge of Manual Accounts</h2>
          <p>
            Running marketing campaigns on Telegram manually means dealing with banned accounts, rotating proxies, and deciphering error limits. HQAdz.io removes these hurdles completely with our automated Telegram session management.
          </p>
        </section>

        <section className="space-y-6">
          <h2 className="text-2xl font-medium text-white">Automated Account Health</h2>
          <p>
            Our infrastructure constantly monitors the account health of every bot. Through smart pacing and flood wait handling, we ensure your message delivery remains consistent without drawing unwanted attention. If an account is flagged, a fresh replacement takes over instantly.
          </p>
        </section>

        <div className="pt-8 border-t border-[#1f1f22]">
          <Link href="/user/login" className="inline-flex items-center gap-2 text-white px-6 py-3 rounded-md font-medium transition-opacity hover:opacity-90" style={{ background: "#2AABEE" }}>
            Let us manage the infrastructure <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </div>
  );
}
