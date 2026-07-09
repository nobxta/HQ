import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

export const metadata: Metadata = {
  title: "Telegram AdBot Dashboard | HQAdz.io",
  description: "Take control of your campaigns with the HQAdz Telegram AdBot dashboard. Monitor posting logs, track analytics, and manage crypto payments effortlessly.",
  alternates: { canonical: "https://hqadz.io/telegram-adbot-dashboard" },
};

export default function DashboardSeoPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#8b8b93] py-32 px-6">
      <div className="max-w-3xl mx-auto space-y-12">
        <header className="space-y-4">
          <h1 className="text-4xl md:text-5xl font-semibold text-white">Telegram AdBot Dashboard</h1>
          <p className="text-lg">Total dashboard control over your Telegram marketing automation.</p>
        </header>

        <section className="space-y-6">
          <h2 className="text-2xl font-medium text-white">Centralized Campaign Management</h2>
          <p>
            The HQAdz.io platform offers an intuitive dashboard control center. From here, you can launch new campaigns, manage target groups, and adjust your ad copy—all from a single, unified interface.
          </p>
        </section>

        <section className="space-y-6">
          <h2 className="text-2xl font-medium text-white">Live Posting Logs</h2>
          <p>
            Transparency is key to our Telegram AdBot platform. Our dashboard provides real-time posting logs, showing you exactly which groups your ad was sent to, the delivery status, and click tracking metrics.
          </p>
        </section>

        <section className="space-y-6">
          <h2 className="text-2xl font-medium text-white">Crypto Payments & Billing</h2>
          <p>
            Fund your campaigns quickly and anonymously using crypto payments directly from the dashboard. We support major cryptocurrencies for seamless billing.
          </p>
        </section>

        <div className="pt-8 border-t border-[#1f1f22]">
          <Link href="/user/login" className="inline-flex items-center gap-2 text-white px-6 py-3 rounded-md font-medium transition-opacity hover:opacity-90" style={{ background: "#2AABEE" }}>
            Access the dashboard <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </div>
  );
}
