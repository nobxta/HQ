import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import MarketingHeader from "@/components/MarketingHeader";
import MarketingFooter from "@/components/MarketingFooter";
import Breadcrumbs from "@/components/Breadcrumbs";

const TITLE = "HQAdz FAQ | Telegram AdBot Questions Answered";
const DESC = "Find answers about HQAdz Telegram AdBot plans, posting accounts, campaign controls, group lists, live logs, replacements and setup.";
const URL = "https://hqadz.io/faq";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESC,
  alternates: { canonical: URL },
  robots: { index: true, follow: true },
  openGraph: { title: TITLE, description: DESC, url: URL, type: "website" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESC },
};

interface FaqItem {
  q: string;
  a: React.ReactNode;
}

interface FaqCategory {
  title: string;
  items: FaqItem[];
}

const CATEGORIES: FaqCategory[] = [
  {
    title: "Getting started",
    items: [
      {
        q: "What is HQAdz?",
        a: "HQAdz is a Telegram advertising platform for launching campaigns, managing posting accounts, selecting target groups and tracking every delivery through a web dashboard.",
      },
      {
        q: "What is a Telegram AdBot?",
        a: "A Telegram AdBot is a managed system that posts your advertisement across a set of Telegram groups using dedicated posting accounts, instead of you posting to each group by hand.",
      },
      {
        q: "How does automated Telegram posting work?",
        a: (
          <>
            You create a campaign, connect the posting accounts included in your plan, add your target groups and
            advertisement, then start the campaign. From there the accounts work through your group list on the
            posting cycle set by your plan, and every attempt is logged. See the full flow on{" "}
            <Link href="/how-it-works" className="text-white underline underline-offset-2 hover:no-underline">how it works</Link>.
          </>
        ),
      },
      {
        q: "How long does setup take?",
        a: "Most orders are prepared within 1–12 hours after your payment is confirmed, depending on current account availability.",
      },
    ],
  },
  {
    title: "Plans and billing",
    items: [
      {
        q: "Are weekly and monthly plans available?",
        a: (
          <>
            Yes. Starter and Enterprise plans are both billed weekly or monthly. See{" "}
            <Link href="/pricing" className="text-white underline underline-offset-2 hover:no-underline">pricing</Link> for current plan details.
          </>
        ),
      },
      {
        q: "What's the difference between Starter and Enterprise plans?",
        a: "Starter plans are sized for smaller campaigns with fewer posting accounts. Enterprise plans include more posting accounts and a faster posting cycle for larger-scale campaigns.",
      },
    ],
  },
  {
    title: "Posting accounts",
    items: [
      {
        q: "Do I need my own Telegram accounts?",
        a: "No. HQAdz provides and manages the posting accounts included in your plan. You just provide the ad.",
      },
      {
        q: "How many posting accounts can I use?",
        a: "The number of posting accounts is set by your plan, from a small Starter allotment up to larger Enterprise account sets.",
      },
    ],
  },
  {
    title: "Telegram groups and advertisements",
    items: [
      {
        q: "Can I choose my own Telegram groups?",
        a: (
          <>
            Yes. Use the HQAdz group list or add your own groups and manage your target list directly from the{" "}
            <Link href="/features" className="text-white underline underline-offset-2 hover:no-underline">dashboard</Link>.
          </>
        ),
      },
      {
        q: "Can I run multiple advertisements?",
        a: "Yes. You can create and manage multiple advertisements for different campaigns or offers, and pair each with its own auto reply.",
      },
    ],
  },
  {
    title: "Campaign controls",
    items: [
      {
        q: "Can I start or stop a campaign?",
        a: "Yes. Start or stop your campaign at any time from the web dashboard or the Telegram controller — nothing keeps posting once you stop it.",
      },
      {
        q: "Can I control the system from Telegram?",
        a: "Yes. The Telegram controller gives you quick access to core campaign controls without opening the web dashboard.",
      },
    ],
  },
  {
    title: "Logs and delivery status",
    items: [
      {
        q: "What do sent, failed and flood-wait logs mean?",
        a: "Every delivery attempt is logged as it happens. \"Sent\" means the post landed in the group, \"failed\" means it didn't go through, and \"flood-wait\" means Telegram temporarily rate-limited that account. A flood-wait clears on its own and the account resumes automatically — all three states are visible per group in your dashboard.",
      },
      {
        q: "How is delivery tracked?",
        a: "Every delivery attempt is logged as it happens, with per-group details in your dashboard, so you can see exactly which groups received your ad and which didn't.",
      },
    ],
  },
  {
    title: "Account replacements",
    items: [
      {
        q: "What is a free account replacement?",
        a: "If a posting account stops working, it's checked and, if eligible, replaced from the free allowance included with your plan, so your campaign keeps running without you having to intervene.",
      },
    ],
  },
  {
    title: "Security and responsible use",
    items: [
      {
        q: "Does HQAdz guarantee sales or results?",
        a: "No. HQAdz provides the posting service described in your plan. Results depend on your ad, offer, and audience — we don't guarantee outcomes.",
      },
      {
        q: "Can HQAdz be used for spam?",
        a: (
          <>
            No. HQAdz is not designed for spam or unlawful campaigns and is not a tool for bypassing Telegram's
            policies. See{" "}
            <Link href="/why-hqadz" className="text-white underline underline-offset-2 hover:no-underline">why HQAdz</Link>{" "}
            for what the platform is and isn't built for.
          </>
        ),
      },
    ],
  },
  {
    title: "Support",
    items: [
      {
        q: "How do I contact support?",
        a: (
          <>
            Reach the team through the{" "}
            <Link href="/contact" className="text-white underline underline-offset-2 hover:no-underline">contact page</Link>,
            by email, or via the official HQAdz Telegram support channel. Existing customers should include their
            order or subscription ID for faster handling.
          </>
        ),
      },
    ],
  },
];

function toPlainText(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(toPlainText).join("");
  if (node && typeof node === "object" && "props" in (node as any)) {
    return toPlainText((node as any).props.children);
  }
  return "";
}

export default function FaqPage() {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: CATEGORIES.flatMap((cat) =>
      cat.items.map((item) => ({
        "@type": "Question",
        name: item.q,
        acceptedAnswer: {
          "@type": "Answer",
          text: toPlainText(item.a),
        },
      }))
    ),
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#8b8b93] antialiased">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <MarketingHeader />

      <div className="max-w-3xl mx-auto px-6 pt-10">
        <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "FAQ", href: "/faq" }]} />
      </div>

      <header className="max-w-3xl mx-auto px-6 pt-8 pb-14 space-y-4">
        <h1 className="text-[36px] sm:text-[44px] font-semibold text-white leading-[1.08] tracking-[-0.03em]">
          Frequently Asked Questions About HQAdz
        </h1>
        <p className="text-[15px] md:text-base text-[#8b8b93] leading-relaxed">
          Answers about plans, posting accounts, target groups, campaign controls, delivery logs and support.
        </p>
      </header>

      <section className="max-w-3xl mx-auto px-6 pb-20 space-y-12">
        {CATEGORIES.map((cat) => (
          <div key={cat.title} className="space-y-4">
            <h2 className="text-lg font-medium text-white">{cat.title}</h2>
            <div className="stagger-children space-y-3">
              {cat.items.map((item) => (
                <details
                  key={item.q}
                  className="group bg-[#0e0e10] border border-[#1f1f22] rounded-lg px-5 py-4 open:border-[#2e2e34]"
                >
                  <summary className="cursor-pointer list-none flex items-center justify-between gap-4 text-[14.5px] font-medium text-white">
                    {item.q}
                    <span className="text-[#5d5d66] shrink-0 transition-transform duration-150 group-open:rotate-45 text-lg leading-none">+</span>
                  </summary>
                  <div className="pt-3 text-[13.5px] leading-relaxed">{item.a}</div>
                </details>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="border-t border-[#1f1f22] py-16 md:py-24 px-6">
        <div className="max-w-5xl mx-auto flex flex-col items-center text-center gap-6">
          <h2 className="text-2xl md:text-[32px] font-medium text-white tracking-[-0.02em] max-w-xl">
            Still have a question?
          </h2>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/contact"
              className="inline-flex items-center gap-2 text-white px-5 py-2.5 rounded-md text-[14px] font-medium transition-opacity hover:opacity-90"
              style={{ background: "#2AABEE" }}
            >
              Contact us <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              href="/pricing"
              className="inline-flex items-center gap-2 text-white px-5 py-2.5 rounded-md text-[14px] font-medium border border-[#2e2e34] hover:border-[#3d3d44] transition-colors"
            >
              View pricing
            </Link>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
