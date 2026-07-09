import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

export const metadata: Metadata = {
  title: "HQAdz Features | Telegram AdBot Platform",
  description: "Explore the powerful features of HQAdz.io. From advanced Telegram session management to real-time posting logs and crypto payments, our Telegram AdBot handles it all.",
  alternates: { canonical: "https://hqadz.io/features" },
};

export default function FeaturesPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#8b8b93] py-32 px-6">
      <div className="max-w-3xl mx-auto space-y-12">
        <header className="space-y-4">
          <h1 className="text-4xl md:text-5xl font-semibold text-white">HQAdz Features</h1>
          <p className="text-lg">Everything you need for successful Telegram marketing automation.</p>
        </header>

        <section className="space-y-6">
          <h2 className="text-2xl font-medium text-white">Automated Posting</h2>
          <p>
            Set your campaign and let the HQAdz Telegram AdBot platform do the rest. Your ads will be delivered across thousands of Telegram groups seamlessly.
          </p>
        </section>

        <section className="space-y-6">
          <h2 className="text-2xl font-medium text-white">Telegram Session Management</h2>
          <p>
            No need to bring your own accounts. We handle the creation, maintenance, and proxy rotation for thousands of Telegram sessions to ensure maximum delivery rates.
          </p>
        </section>

        <section className="space-y-6">
          <h2 className="text-2xl font-medium text-white">Real-Time Posting Logs</h2>
          <p>
            Track your campaign's performance with granular, real-time posting logs available directly in your dashboard control. Know exactly where and when your ads land.
          </p>
        </section>

        <div className="pt-8 border-t border-[#1f1f22]">
          <Link href="/user/login" className="inline-flex items-center gap-2 text-white px-6 py-3 rounded-md font-medium transition-opacity hover:opacity-90" style={{ background: "#2AABEE" }}>
            View pricing <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </div>
  );
}
