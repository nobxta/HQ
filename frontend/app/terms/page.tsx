import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service | HQAdz.io",
  description: "Terms of Service for HQAdz.io. Read the rules and guidelines for using the HQAdz Telegram AdBot platform.",
  alternates: { canonical: "https://hqadz.io/terms" },
};

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#8b8b93] py-32 px-6">
      <div className="max-w-3xl mx-auto space-y-12">
        <header className="space-y-4">
          <h1 className="text-4xl md:text-5xl font-semibold text-white">Terms of Service</h1>
          <p className="text-lg">Last updated: July 2026</p>
        </header>

        <section className="space-y-6">
          <h2 className="text-2xl font-medium text-white">Usage of the Telegram AdBot Platform</h2>
          <p>
            By accessing HQAdz.io, you agree to abide by our terms of service. Our Telegram advertising bot is designed for legitimate marketing purposes. We strictly prohibit the use of our platform for spreading malware, phishing, or illegal content.
          </p>
        </section>

        <section className="space-y-6">
          <h2 className="text-2xl font-medium text-white">Service Level & Account Health</h2>
          <p>
            We strive to provide uninterrupted service through advanced Telegram session management and flood wait handling. However, delivery rates may vary based on Telegram's network constraints. We guarantee free account replacements for any bots limited during your active subscription.
          </p>
        </section>

        <section className="space-y-6">
          <h2 className="text-2xl font-medium text-white">Crypto Payments & Refunds</h2>
          <p>
            All subscriptions and services purchased via crypto payments are final. Due to the anonymous nature of cryptocurrency, refunds are provided solely at the discretion of the HQAdz support team.
          </p>
        </section>
      </div>
    </div>
  );
}
