import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Eye, Layers, SlidersHorizontal, Target, Users2, Bot, ShieldCheck, X, Check } from "lucide-react";
import MarketingHeader from "@/components/MarketingHeader";
import MarketingFooter from "@/components/MarketingFooter";
import Breadcrumbs from "@/components/Breadcrumbs";

export const metadata: Metadata = {
  title: "Why Choose HQAdz for Telegram Advertising Automation",
  description: "See why advertisers use HQAdz to manage Telegram posting accounts, control campaigns, track activity and operate Telegram advertising from one platform.",
  alternates: { canonical: "https://hqadz.io/why-hqadz" },
};

const DIFFERENTIATORS = [
  { icon: Layers, title: "One place to manage posting activity", body: "Accounts, groups, advertisements and campaign status all live in a single dashboard instead of being spread across manual logins and spreadsheets." },
  { icon: Eye, title: "Clear successful and failed delivery logs", body: "Every posting attempt is recorded as it happens, including flood-wait events, so you can see exactly what is working and what isn't." },
  { icon: SlidersHorizontal, title: "Flexible weekly and monthly plans", body: "Starter and Enterprise plans are billed weekly or monthly, sized by the number of posting accounts and posting cycle you need." },
  { icon: Target, title: "Custom group targeting", body: "Build your own Telegram group lists and control exactly where advertisements are posted, instead of relying on a fixed or shared list." },
  { icon: Users2, title: "Multiple posting accounts depending on plan", body: "Plans include a set number of managed posting accounts, from a small starter allotment up to larger enterprise-scale sets." },
  { icon: Bot, title: "Start and stop control, web console and Telegram controller", body: "Pause or resume a campaign whenever you need to, from the web dashboard or directly through the Telegram controller." },
  { icon: ShieldCheck, title: "Transparent plan limits and replacement allowances", body: "Each plan states its session count, posting cycle and free replacement allowance up front, and account replacements are tracked against that allowance." },
];

const COMPARISON = [
  { label: "Visibility", unmanaged: "Posting is done by hand, one group at a time, with no consolidated record.", hqadz: "Every delivery attempt is logged and visible in the dashboard as it happens." },
  { label: "Account management", unmanaged: "Accounts are tracked manually; a limited account stalls the whole workflow.", hqadz: "Accounts are monitored, with free replacements included according to your plan." },
  { label: "Group organization", unmanaged: "Group lists live in notes or chat history and drift out of date.", hqadz: "Custom group lists are managed directly in the dashboard and can be updated any time." },
  { label: "Posting control", unmanaged: "Starting or stopping means manually pausing each account.", hqadz: "Start or stop the whole campaign from the dashboard or Telegram controller." },
  { label: "Logs", unmanaged: "No structured record of what was sent, where, or whether it succeeded.", hqadz: "Successful, failed and flood-wait status is tracked per post." },
  { label: "Campaign status", unmanaged: "Status lives in the operator's memory or a spreadsheet.", hqadz: "Plan validity and account status are visible in the dashboard at all times." },
  { label: "Operational transparency", unmanaged: "Hard to audit after the fact.", hqadz: "Campaign activity is transparent and reviewable at any point." },
];

const WHO_FOR = [
  "Independent advertisers promoting a product, service, or channel",
  "Telegram community promoters growing a group or channel",
  "Agencies managing repeated campaigns across multiple clients",
  "Teams operating several posting accounts at once",
];

const WHO_NOT_FOR = [
  "A guarantee of sales or conversions",
  "A tool for bypassing Telegram policies",
  "A replacement for good ad copy or targeting",
  "Designed for spam or unlawful campaigns",
];

export default function WhyHQAdzPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#8b8b93] antialiased">
      <MarketingHeader />

      <div className="max-w-5xl mx-auto px-6 pt-10">
        <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "Why HQAdz", href: "/why-hqadz" }]} />
      </div>

      {/* Hero */}
      <header className="max-w-5xl mx-auto px-6 pt-8 pb-16 md:pt-12 md:pb-20">
        <div className="max-w-2xl space-y-5">
          <h1 className="text-[36px] sm:text-[44px] md:text-[52px] font-semibold text-white leading-[1.08] tracking-[-0.03em]">
            Why Advertisers Choose HQAdz
          </h1>
          <p className="text-[15px] md:text-base text-[#8b8b93] leading-relaxed">
            HQAdz focuses on control, visibility and practical campaign management — managed posting accounts,
            custom group targeting, and a log of every delivery attempt, rather than a black-box script that
            posts and tells you nothing about what happened.
          </p>
        </div>
      </header>

      {/* Key differentiators */}
      <section className="border-t border-[#1f1f22] py-16 md:py-24 px-6">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-2xl md:text-[28px] font-medium text-white tracking-[-0.02em] mb-10">
            Key differentiators
          </h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {DIFFERENTIATORS.map(({ icon: Icon, title, body }) => (
              <div key={title} className="bg-[#0e0e10] border border-[#1f1f22] rounded-xl p-6 space-y-3">
                <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-[#16161a] border border-[#1f1f22]">
                  <Icon className="w-4 h-4 text-[#2AABEE]" />
                </div>
                <h3 className="text-[15px] font-medium text-white leading-snug">{title}</h3>
                <p className="text-[13.5px] leading-relaxed">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Comparison */}
      <section className="border-t border-[#1f1f22] py-16 md:py-24 px-6">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-2xl md:text-[28px] font-medium text-white tracking-[-0.02em] mb-3">
            A managed workflow vs. posting by hand
          </h2>
          <p className="text-[14px] mb-10 max-w-2xl">
            Here's how a typical unmanaged Telegram posting workflow compares to running the same campaign through HQAdz.
          </p>
          <div className="overflow-x-auto rounded-xl border border-[#1f1f22]">
            <table className="w-full min-w-[640px] text-left border-collapse">
              <thead>
                <tr className="bg-[#0e0e10] text-[12px] uppercase tracking-wide text-[#5d5d66]">
                  <th className="px-5 py-3.5 font-medium">Area</th>
                  <th className="px-5 py-3.5 font-medium">Unmanaged posting</th>
                  <th className="px-5 py-3.5 font-medium text-white">HQAdz managed workflow</th>
                </tr>
              </thead>
              <tbody>
                {COMPARISON.map((row, i) => (
                  <tr key={row.label} className={i % 2 === 0 ? "bg-[#0a0a0a]" : "bg-[#0d0d10]"}>
                    <td className="px-5 py-4 text-[13.5px] font-medium text-white align-top border-t border-[#1f1f22] whitespace-nowrap">{row.label}</td>
                    <td className="px-5 py-4 text-[13.5px] align-top border-t border-[#1f1f22]">
                      <span className="flex items-start gap-2">
                        <X className="w-3.5 h-3.5 text-[#5d5d66] mt-0.5 shrink-0" />
                        {row.unmanaged}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-[13.5px] text-[#c7c7cc] align-top border-t border-[#1f1f22]">
                      <span className="flex items-start gap-2">
                        <Check className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "#2AABEE" }} />
                        {row.hqadz}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Who it is for / not for */}
      <section className="border-t border-[#1f1f22] py-16 md:py-24 px-6">
        <div className="max-w-5xl mx-auto grid md:grid-cols-2 gap-8">
          <div className="bg-[#0e0e10] border border-[#1f1f22] rounded-xl p-6 space-y-4">
            <h2 className="text-[17px] font-medium text-white">Who it's for</h2>
            <ul className="space-y-2.5">
              {WHO_FOR.map((item) => (
                <li key={item} className="text-[13.5px] flex items-start gap-2.5">
                  <Check className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "#2AABEE" }} />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div className="bg-[#0e0e10] border border-[#1f1f22] rounded-xl p-6 space-y-4">
            <h2 className="text-[17px] font-medium text-white">Who it's not for</h2>
            <p className="text-[13px] text-[#5d5d66]">HQAdz is honest about its limits. It is not:</p>
            <ul className="space-y-2.5">
              {WHO_NOT_FOR.map((item) => (
                <li key={item} className="text-[13.5px] flex items-start gap-2.5">
                  <X className="w-3.5 h-3.5 text-[#5d5d66] shrink-0 mt-0.5" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-[#1f1f22] py-16 md:py-24 px-6">
        <div className="max-w-5xl mx-auto flex flex-col items-center text-center gap-6">
          <h2 className="text-2xl md:text-[32px] font-medium text-white tracking-[-0.02em] max-w-xl">
            See what's actually included
          </h2>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/features"
              className="inline-flex items-center gap-2 text-white px-5 py-2.5 rounded-md text-[14px] font-medium transition-opacity hover:opacity-90"
              style={{ background: "#2AABEE" }}
            >
              Explore features <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              href="/pricing"
              className="inline-flex items-center gap-2 text-white px-5 py-2.5 rounded-md text-[14px] font-medium border border-[#2e2e34] hover:border-[#3d3d44] transition-colors"
            >
              View pricing
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
