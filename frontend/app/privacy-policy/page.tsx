import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy | HQAdz.io",
  description: "Read the HQAdz.io privacy policy. Learn how we protect your data while using our Telegram AdBot platform for automated advertising.",
  alternates: { canonical: "https://hqadz.io/privacy-policy" },
};

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#8b8b93] py-32 px-6">
      <div className="max-w-3xl mx-auto space-y-12">
        <header className="space-y-4">
          <h1 className="text-4xl md:text-5xl font-semibold text-white">Privacy Policy</h1>
          <p className="text-lg">Last updated: July 2026</p>
        </header>

        <section className="space-y-6">
          <h2 className="text-2xl font-medium text-white">Data Protection at HQAdz</h2>
          <p>
            At HQAdz.io, privacy is paramount. When you use our Telegram AdBot platform, we ensure that your campaign data, target groups, and ad copies are securely encrypted. We do not share your posting logs with third parties.
          </p>
        </section>

        <section className="space-y-6">
          <h2 className="text-2xl font-medium text-white">Crypto Payments & Anonymity</h2>
          <p>
            We process transactions via crypto payments to maintain your financial privacy. We do not store sensitive payment information directly on our servers, ensuring your anonymity while using the Telegram advertising bot.
          </p>
        </section>

        <section className="space-y-6">
          <h2 className="text-2xl font-medium text-white">Telegram Session Management Privacy</h2>
          <p>
            The accounts used by our platform for automated posting are managed entirely by our infrastructure. HQAdz does not require you to link your personal Telegram sessions, ensuring your personal identity is never exposed during campaigns.
          </p>
        </section>
      </div>
    </div>
  );
}
