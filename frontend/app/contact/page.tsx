import type { Metadata } from "next";
import Link from "next/link";
import { DollarSign, LifeBuoy, CreditCard, Wrench, RefreshCcw, Mail, Send, MailPlus, Search, MessageCircle } from "lucide-react";
import MarketingHeader from "@/components/MarketingHeader";
import MarketingFooter from "@/components/MarketingFooter";
import Breadcrumbs from "@/components/Breadcrumbs";
import ContactForm from "@/components/ContactForm";

const TITLE = "Contact HQAdz | Sales and Telegram AdBot Support";
const DESC = "Contact HQAdz for Telegram AdBot setup, plan information, billing questions, technical support and campaign assistance.";
const URL = "https://hqadz.io/contact";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESC,
  alternates: { canonical: URL },
  robots: { index: true, follow: true },
  openGraph: { title: TITLE, description: DESC, url: URL, type: "website" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESC },
};

const CATEGORIES = [
  { icon: DollarSign, title: "Sales and plan questions", body: "Not sure which plan fits your campaign size? Ask before you buy." },
  { icon: LifeBuoy, title: "Existing customer support", body: "Already running a campaign and need help? Include your order ID for a faster reply." },
  { icon: CreditCard, title: "Billing and payment questions", body: "Questions about a crypto payment, invoice, or plan renewal." },
  { icon: Wrench, title: "Technical setup assistance", body: "Help getting your accounts, groups or advertisements configured." },
  { icon: RefreshCcw, title: "Account replacement requests", body: "Report a posting account that needs replacing under your plan's allowance." },
];

const WORKFLOW = [
  { icon: MailPlus, step: "You send a message", body: "Fill out the form or email/message us directly with your topic and details." },
  { icon: Search, step: "We review it", body: "Your message goes to the team, matched against your topic and, if provided, your order ID." },
  { icon: MessageCircle, step: "We reply", body: "You get a reply back by email or Telegram, whichever you used to reach us." },
];

export default function ContactPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#8b8b93] antialiased">
      <MarketingHeader />

      <div className="max-w-5xl mx-auto px-6 pt-10">
        <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "Contact", href: "/contact" }]} />
      </div>

      <header className="max-w-5xl mx-auto px-6 pt-8 pb-14 space-y-4">
        <h1 className="text-[36px] sm:text-[44px] font-semibold text-white leading-[1.08] tracking-[-0.03em]">
          Contact the HQAdz Team
        </h1>
        <p className="text-[15px] md:text-base text-[#8b8b93] leading-relaxed max-w-2xl">
          Questions about plans, billing, setup, or an active campaign — reach out below or use the form and
          we'll get back to you.
        </p>
      </header>

      <section className="max-w-5xl mx-auto px-6 pb-16">
        <div className="stagger-children grid sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {CATEGORIES.map(({ icon: Icon, title, body }) => (
            <div key={title} className="bg-[#0e0e10] border border-[#1f1f22] rounded-xl p-5 space-y-2.5 transition-colors hover:border-[#2e2e34]">
              <Icon className="w-4 h-4 text-[#2AABEE]" />
              <h3 className="text-[13.5px] font-medium text-white leading-snug">{title}</h3>
              <p className="text-[12.5px] leading-relaxed">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* What happens after you submit */}
      <section className="border-t border-[#1f1f22] py-16 px-6">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-[17px] font-medium text-white mb-8">What happens after you reach out</h2>
          <ol className="stagger-children grid sm:grid-cols-3 gap-4">
            {WORKFLOW.map(({ icon: Icon, step, body }, i) => (
              <li key={step} className="bg-[#0e0e10] border border-[#1f1f22] rounded-xl p-5 space-y-2.5">
                <div className="flex items-center gap-2.5">
                  <span
                    className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold text-white shrink-0"
                    style={{ background: "#2AABEE" }}
                  >
                    {i + 1}
                  </span>
                  <Icon className="w-4 h-4 text-[#2AABEE]" />
                </div>
                <h3 className="text-[14px] font-medium text-white">{step}</h3>
                <p className="text-[13px] leading-relaxed">{body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="border-t border-[#1f1f22] py-16 px-6">
        <div className="max-w-5xl mx-auto grid md:grid-cols-[1.4fr_1fr] gap-10">
          <div className="bg-[#0e0e10] border border-[#1f1f22] rounded-xl p-6 md:p-8">
            <h2 className="text-[17px] font-medium text-white mb-6">Send a message</h2>
            <ContactForm />
          </div>

          <div className="space-y-8">
            <div className="space-y-3">
              <h2 className="text-[17px] font-medium text-white">Direct contact</h2>
              <ul className="space-y-3 text-[13.5px]">
                <li className="flex items-center gap-2.5">
                  <Mail className="w-4 h-4 text-[#2AABEE] shrink-0" />
                  <a href="mailto:support@hqadz.io" className="hover:text-white transition-colors">support@hqadz.io</a>
                </li>
                <li className="flex items-center gap-2.5">
                  <Send className="w-4 h-4 text-[#2AABEE] shrink-0" />
                  <a href="https://t.me/HQAdzSupport" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">@HQAdzSupport on Telegram</a>
                </li>
              </ul>
            </div>

            <div className="space-y-2">
              <h2 className="text-[15px] font-medium text-white">Response expectations</h2>
              <p className="text-[13px] leading-relaxed">
                We reply to email and Telegram support messages as they come in. We don't publish a fixed
                response-time guarantee, but existing customers should include their order or subscription ID
                for the fastest handling.
              </p>
            </div>

            <div className="space-y-2">
              <h2 className="text-[15px] font-medium text-white">Helpful links</h2>
              <ul className="space-y-1.5 text-[13.5px]">
                <li><Link href="/faq" className="hover:text-white transition-colors">FAQ</Link></li>
                <li><Link href="/pricing" className="hover:text-white transition-colors">Pricing</Link></li>
                <li><Link href="/privacy-policy" className="hover:text-white transition-colors">Privacy policy</Link></li>
                <li><Link href="/terms" className="hover:text-white transition-colors">Terms</Link></li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
