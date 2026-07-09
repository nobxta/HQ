import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

export const metadata: Metadata = {
  title: "HQAdz Pricing | Telegram AdBot Platform",
  description: "Transparent pricing for the HQAdz Telegram AdBot platform. Pay securely via crypto payments and get instant access to automated Telegram advertising.",
  alternates: { canonical: "https://hqadz.io/pricing" },
};

export default function PricingPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#8b8b93] py-32 px-6">
      <div className="max-w-3xl mx-auto space-y-12">
        <header className="space-y-4">
          <h1 className="text-4xl md:text-5xl font-semibold text-white">HQAdz Pricing</h1>
          <p className="text-lg">Scale your reach with our flexible Telegram advertising bot plans.</p>
        </header>

        <section className="space-y-6">
          <h2 className="text-2xl font-medium text-white">Crypto Payments Accepted</h2>
          <p>
            At HQAdz.io, we prioritize privacy and speed. We accept various crypto payments so you can fund your campaigns securely and start posting instantly.
          </p>
        </section>

        <section className="space-y-6">
          <h2 className="text-2xl font-medium text-white">What's Included?</h2>
          <ul className="list-disc pl-5 space-y-2">
            <li>Fully managed Telegram session management</li>
            <li>Real-time posting logs and analytics</li>
            <li>Automatic flood wait handling for account health</li>
            <li>Dashboard control for campaign management</li>
          </ul>
        </section>

        <div className="pt-8 border-t border-[#1f1f22]">
          <Link href="/#pricing" className="inline-flex items-center gap-2 text-white px-6 py-3 rounded-md font-medium transition-opacity hover:opacity-90" style={{ background: "#2AABEE" }}>
            See detailed plans <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </div>
  );
}
