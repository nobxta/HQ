import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Users, ListChecks, MessageSquare, Play, ScrollText, LayoutDashboard, Bot, ShieldCheck, RefreshCcw, Eye } from "lucide-react";
import MarketingHeader from "@/components/MarketingHeader";
import MarketingFooter from "@/components/MarketingFooter";
import Breadcrumbs from "@/components/Breadcrumbs";

export const metadata: Metadata = {
  title: "Telegram AdBot Features and Automation Tools",
  description: "Explore HQAdz features for Telegram advertising, including posting account management, campaign controls, custom group lists, live logs and automated posting tools.",
  alternates: { canonical: "https://hqadz.io/features" },
};

const CATEGORIES = [
  {
    icon: Play,
    title: "Campaign control",
    body: "Create a campaign, attach your advertisement, and start or stop posting whenever you need to. Campaigns run on the posting cycle and gap defined by your plan, and you stay in control of when the AdBot is active.",
    items: ["Start and stop controls", "Multiple advertisements per account", "Custom auto replies"],
  },
  {
    icon: Users,
    title: "Account and session management",
    body: "Every plan includes a set number of managed posting accounts (sessions). HQAdz monitors account health and handles free replacements according to the allowance in your plan, so a limited or broken account doesn't stall your campaign.",
    items: ["Multiple posting accounts per plan", "Free account replacement according to plan", "Plan validity and account status tracking"],
  },
  {
    icon: ListChecks,
    title: "Target group management",
    body: "Build your own custom Telegram group lists and decide exactly where your advertisements are posted, directly from the dashboard.",
    items: ["Custom Telegram group lists", "Add or remove groups at any time"],
  },
  {
    icon: ScrollText,
    title: "Monitoring and logs",
    body: "Every posting attempt is recorded as it happens. Review successful posts, failed attempts, and flood-wait events per group so you always know what your accounts are doing.",
    items: ["Live posting logs", "Successful, failed and flood-wait status tracking", "Transparent campaign activity"],
  },
  {
    icon: LayoutDashboard,
    title: "Dashboard and Telegram control",
    body: "Manage accounts, groups, advertisements and campaign status from the web dashboard, or use the Telegram controller for quick access without opening a browser.",
    items: ["Responsive web dashboard", "Telegram controller bot"],
  },
];

const WORKFLOW = [
  "Create campaign",
  "Connect posting accounts",
  "Add target groups",
  "Configure advertisements",
  "Start posting",
  "Monitor live results",
];

export default function FeaturesPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#8b8b93] antialiased">
      <MarketingHeader />

      <div className="max-w-5xl mx-auto px-6 pt-10">
        <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "Features", href: "/features" }]} />
      </div>

      {/* Hero */}
      <header className="max-w-5xl mx-auto px-6 pt-8 pb-16 md:pt-12 md:pb-20">
        <div className="max-w-2xl space-y-5">
          <h1 className="text-[36px] sm:text-[44px] md:text-[52px] font-semibold text-white leading-[1.08] tracking-[-0.03em]">
            Telegram Advertising Features Built for Control
          </h1>
          <p className="text-[15px] md:text-base text-[#8b8b93] leading-relaxed">
            HQAdz gives you managed posting accounts, custom group targeting, and live visibility into every
            delivery attempt — all from one dashboard or the Telegram controller. Nothing runs silently in the
            background without a log to show for it.
          </p>
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <Link
              href="/pricing"
              className="inline-flex items-center gap-2 text-white px-5 py-2.5 rounded-md text-[14px] font-medium transition-opacity hover:opacity-90"
              style={{ background: "#2AABEE" }}
            >
              View pricing <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              href="/how-it-works"
              className="inline-flex items-center gap-2 text-white px-5 py-2.5 rounded-md text-[14px] font-medium border border-[#2e2e34] hover:border-[#3d3d44] transition-colors"
            >
              See how it works
            </Link>
          </div>
        </div>
      </header>

      {/* Core feature overview */}
      <section className="border-t border-[#1f1f22] py-16 md:py-24 px-6">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-2xl md:text-[28px] font-medium text-white tracking-[-0.02em] mb-10">
            Core feature overview
          </h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              { icon: Users, label: "Multiple posting accounts" },
              { icon: ListChecks, label: "Custom Telegram group lists" },
              { icon: MessageSquare, label: "Multiple advertisements" },
              { icon: Bot, label: "Custom auto replies" },
              { icon: Play, label: "Start and stop controls" },
              { icon: ScrollText, label: "Live posting logs" },
              { icon: Eye, label: "Successful, failed and flood-wait tracking" },
              { icon: LayoutDashboard, label: "Web dashboard" },
              { icon: Bot, label: "Telegram controller" },
              { icon: ShieldCheck, label: "Plan validity and account status" },
              { icon: RefreshCcw, label: "Free account replacement per plan" },
              { icon: Eye, label: "Transparent campaign activity" },
            ].map(({ icon: Icon, label }) => (
              <div
                key={label}
                className="flex items-center gap-3 bg-[#0e0e10] border border-[#1f1f22] rounded-lg px-4 py-3.5"
              >
                <Icon className="w-4 h-4 text-[#2AABEE] shrink-0" />
                <span className="text-[13.5px] text-[#c7c7cc]">{label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Feature detail sections */}
      <section className="border-t border-[#1f1f22] py-16 md:py-24 px-6">
        <div className="max-w-5xl mx-auto space-y-14">
          <h2 className="text-2xl md:text-[28px] font-medium text-white tracking-[-0.02em]">
            Built for how advertisers actually run campaigns
          </h2>
          <div className="grid md:grid-cols-2 gap-8">
            {CATEGORIES.map(({ icon: Icon, title, body, items }) => (
              <div key={title} className="bg-[#0e0e10] border border-[#1f1f22] rounded-xl p-6 space-y-4">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-[#16161a] border border-[#1f1f22]">
                    <Icon className="w-4 h-4 text-[#2AABEE]" />
                  </div>
                  <h3 className="text-[17px] font-medium text-white">{title}</h3>
                </div>
                <p className="text-[14px] leading-relaxed">{body}</p>
                <ul className="space-y-1.5 pt-1">
                  {items.map((item) => (
                    <li key={item} className="text-[13px] text-[#8b8b93] flex items-start gap-2">
                      <span className="w-1 h-1 rounded-full bg-[#3d3d44] mt-2 shrink-0" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Workflow */}
      <section className="border-t border-[#1f1f22] py-16 md:py-24 px-6">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-2xl md:text-[28px] font-medium text-white tracking-[-0.02em] mb-10">
            From setup to live delivery
          </h2>
          <ol className="flex flex-col md:flex-row md:items-center flex-wrap gap-3 md:gap-2">
            {WORKFLOW.map((step, i) => (
              <li key={step} className="flex items-center gap-3">
                <div className="flex items-center gap-3 bg-[#0e0e10] border border-[#1f1f22] rounded-lg px-4 py-3">
                  <span
                    className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-medium text-white shrink-0"
                    style={{ background: "#2AABEE" }}
                  >
                    {i + 1}
                  </span>
                  <span className="text-[13.5px] text-[#c7c7cc] whitespace-nowrap">{step}</span>
                </div>
                {i < WORKFLOW.length - 1 && (
                  <ArrowRight className="w-4 h-4 text-[#3d3d44] hidden md:block shrink-0" />
                )}
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Final CTA */}
      <section className="border-t border-[#1f1f22] py-16 md:py-24 px-6">
        <div className="max-w-5xl mx-auto flex flex-col items-center text-center gap-6">
          <h2 className="text-2xl md:text-[32px] font-medium text-white tracking-[-0.02em] max-w-xl">
            Ready to see it running on your own campaign?
          </h2>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/pricing"
              className="inline-flex items-center gap-2 text-white px-5 py-2.5 rounded-md text-[14px] font-medium transition-opacity hover:opacity-90"
              style={{ background: "#2AABEE" }}
            >
              View pricing <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              href="/how-it-works"
              className="inline-flex items-center gap-2 text-white px-5 py-2.5 rounded-md text-[14px] font-medium border border-[#2e2e34] hover:border-[#3d3d44] transition-colors"
            >
              How it works
            </Link>
            <Link
              href="/contact"
              className="inline-flex items-center gap-2 text-[#8b8b93] hover:text-white px-5 py-2.5 rounded-md text-[14px] font-medium transition-colors"
            >
              Contact us
            </Link>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
