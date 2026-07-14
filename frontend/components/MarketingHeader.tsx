import Link from "next/link";
import BrandMark from "@/components/BrandMark";

const LINKS: [string, string][] = [
  ["Features", "/features"],
  ["Why HQAdz", "/why-hqadz"],
  ["Pricing", "/pricing"],
  ["How it works", "/how-it-works"],
  ["FAQ", "/faq"],
];

export default function MarketingHeader() {
  return (
    <nav className="sticky top-0 z-50 bg-[#0a0a0a]/85 backdrop-blur-lg border-b border-[#1f1f22]">
      <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2">
          <BrandMark height={22} />
        </Link>

        <div className="hidden md:flex items-center gap-0.5">
          {LINKS.map(([label, href]) => (
            <Link
              key={href}
              href={href}
              className="text-[13px] text-[#8b8b93] hover:text-white px-3 py-1.5 transition-colors duration-150"
            >
              {label}
            </Link>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <Link
            href="/user/login"
            className="hidden sm:inline-flex text-[13px] text-[#8b8b93] hover:text-white px-3 py-1.5 transition-colors duration-150"
          >
            Log in
          </Link>
          <Link
            href="/user/login"
            className="text-[13px] font-medium text-white px-3.5 py-1.5 rounded-md transition-opacity duration-150 hover:opacity-90"
            style={{ background: "#2AABEE" }}
          >
            Start advertising
          </Link>
        </div>
      </div>
    </nav>
  );
}
