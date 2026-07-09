import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, MessageCircle } from "lucide-react";

export const metadata: Metadata = {
  title: "Telegram AdBot Platform | HQAdz.io",
  description: "The ultimate Telegram AdBot platform for marketing automation. HQAdz manages your Telegram sessions, handles flood waits, and posts to thousands of groups automatically.",
  alternates: { canonical: "https://hqadz.io/telegram-adbot" },
};

const FAQS = [
  { q: "Do I need my own Telegram accounts?", a: "No. HQAdz provisions and maintains every account, proxy, and Telegram session. You only write the ad." },
  { q: "How quickly can a campaign start?", a: "Under two minutes after payment confirms via crypto payments. Plans activate automatically on our Telegram AdBot platform — no approval queue." },
  { q: "What happens if an account gets limited?", a: "A healthy replacement takes over within minutes, automatically. Your plan includes free replacements and automatic flood wait handling for account health." },
  { q: "Can I choose specific groups?", a: "Yes. Filter by niche, language, and member count — or hand-pick groups one by one directly from the dashboard control." },
  { q: "How is delivery tracked?", a: "Every post is logged the moment it lands, with per-group posting logs in your dashboard." },
];

export default function TelegramAdBotPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#8b8b93] py-32 px-6">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            "mainEntity": FAQS.map(faq => ({
              "@type": "Question",
              "name": faq.q,
              "acceptedAnswer": {
                "@type": "Answer",
                "text": faq.a
              }
            }))
          })
        }}
      />
      <div className="max-w-3xl mx-auto space-y-12">
        <header className="space-y-4">
          <h1 className="text-4xl md:text-5xl font-semibold text-white">HQAdz Telegram AdBot Platform</h1>
          <p className="text-lg">Automate your Telegram marketing with the most advanced Telegram advertising bot on the market.</p>
        </header>

        <section className="space-y-6">
          <h2 className="text-2xl font-medium text-white">Why Use a Telegram AdBot?</h2>
          <p>
            Manual posting to Telegram groups is slow, tedious, and prone to account bans. With the HQAdz Telegram AdBot platform, you can scale your reach effortlessly. We handle the heavy lifting, including Telegram session management, proxy rotation, and flood wait handling, so you can focus on writing high-converting ads.
          </p>
        </section>

        <section className="space-y-6">
          <h2 className="text-2xl font-medium text-white">Built for Scale</h2>
          <p>
            Whether you are a solo marketer or a large agency, HQAdz.io scales with your needs. Our Telegram advertising bot can post to thousands of groups concurrently, generating massive visibility for your crypto project, SaaS, or service.
          </p>
        </section>

        <section className="space-y-6">
          <h2 className="text-2xl font-medium text-white">Frequently Asked Questions</h2>
          <div className="space-y-6">
            {FAQS.map((faq, i) => (
              <div key={i} className="bg-[#0e0e10] p-6 rounded-lg border border-[#1f1f22]">
                <h3 className="text-lg font-medium text-white mb-2">{faq.q}</h3>
                <p>{faq.a}</p>
              </div>
            ))}
          </div>
        </section>

        <div className="pt-8 border-t border-[#1f1f22]">
          <Link href="/user/login" className="inline-flex items-center gap-2 text-white px-6 py-3 rounded-md font-medium transition-opacity hover:opacity-90" style={{ background: "#2AABEE" }}>
            Start your campaign <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </div>
  );
}
