import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

export const metadata: Metadata = {
  title: "How It Works | HQAdz Telegram AdBot",
  description: "Learn how the HQAdz Telegram advertising bot works. Create campaigns, manage targets, and watch the automated posting logs in real time.",
  alternates: { canonical: "https://hqadz.io/how-it-works" },
};

export default function HowItWorksPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#8b8b93] py-32 px-6">
      <div className="max-w-3xl mx-auto space-y-12">
        <header className="space-y-4">
          <h1 className="text-4xl md:text-5xl font-semibold text-white">How HQAdz Works</h1>
          <p className="text-lg">Launch your Telegram marketing campaign in under two minutes.</p>
        </header>

        <section className="space-y-6">
          <h2 className="text-2xl font-medium text-white">1. Create Your Ad</h2>
          <p>
            Write your promotional message, attach links or media, and set it up within the HQAdz Telegram AdBot platform. Our intuitive dashboard control makes campaign creation a breeze.
          </p>
        </section>

        <section className="space-y-6">
          <h2 className="text-2xl font-medium text-white">2. Target Your Audience</h2>
          <p>
            Select from thousands of curated Telegram groups based on your niche. Whether it's crypto, DeFi, NFTs, or SaaS, we have the right audience for your product.
          </p>
        </section>

        <section className="space-y-6">
          <h2 className="text-2xl font-medium text-white">3. Automated Delivery</h2>
          <p>
            Once launched, our Telegram advertising bot takes over. We handle the Telegram session management and flood wait handling, ensuring your ads are delivered safely and efficiently. You can monitor the progress through live posting logs.
          </p>
        </section>

        <div className="pt-8 border-t border-[#1f1f22]">
          <Link href="/user/login" className="inline-flex items-center gap-2 text-white px-6 py-3 rounded-md font-medium transition-opacity hover:opacity-90" style={{ background: "#2AABEE" }}>
            Start your first campaign <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </div>
  );
}
