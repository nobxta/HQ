import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Contact Us | HQAdz.io",
  description: "Get in touch with the HQAdz team. We provide dedicated support for our Telegram AdBot platform, enterprise campaign setups, and technical inquiries.",
  alternates: { canonical: "https://hqadz.io/contact" },
};

export default function ContactPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#8b8b93] py-32 px-6">
      <div className="max-w-3xl mx-auto space-y-12">
        <header className="space-y-4">
          <h1 className="text-4xl md:text-5xl font-semibold text-white">Contact HQAdz</h1>
          <p className="text-lg">We're here to help you succeed with your Telegram marketing.</p>
        </header>

        <section className="space-y-6">
          <h2 className="text-2xl font-medium text-white">Support for the Telegram AdBot Platform</h2>
          <p>
            Whether you have questions about our Telegram advertising bot, need help with dashboard control, or require custom enterprise solutions, our team is ready to assist. HQAdz.io is committed to providing top-tier support for all our users.
          </p>
        </section>

        <section className="space-y-6">
          <h2 className="text-2xl font-medium text-white">Reach Out</h2>
          <p>
            The fastest way to reach us is through our official Telegram support channel. You can also email us directly for partnership inquiries or issues related to crypto payments.
          </p>
          <ul className="list-disc pl-5 space-y-2 mt-4">
            <li><strong>Email:</strong> support@hqadz.io</li>
            <li><strong>Telegram:</strong> @HQAdzSupport</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
