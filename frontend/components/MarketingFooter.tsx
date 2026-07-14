import Link from "next/link";
import BrandMark from "@/components/BrandMark";

export default function MarketingFooter() {
  return (
    <footer className="border-t border-[#1f1f22]">
      <div className="max-w-5xl mx-auto px-6 py-10 flex flex-col gap-6">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          <div className="flex items-center gap-2">
            <BrandMark height={18} />
            <span className="text-[12px] text-[#5d5d66] ml-3">© 2025</span>
          </div>
          <div className="flex items-center gap-5 text-[12px] text-[#5d5d66]">
            <Link href="/pricing" className="hover:text-white transition-colors duration-150">Pricing</Link>
            <Link href="/faq" className="hover:text-white transition-colors duration-150">FAQ</Link>
            <Link href="/terms" className="hover:text-white transition-colors duration-150">Terms</Link>
            <Link href="/privacy-policy" className="hover:text-white transition-colors duration-150">Privacy</Link>
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              Operational
            </span>
          </div>
        </div>
        <nav aria-label="Site pages" className="flex flex-wrap gap-x-5 gap-y-2 text-[12px] text-[#5d5d66]">
          <Link href="/telegram-adbot" className="hover:text-white transition-colors duration-150">Telegram AdBot</Link>
          <Link href="/features" className="hover:text-white transition-colors duration-150">Features</Link>
          <Link href="/why-hqadz" className="hover:text-white transition-colors duration-150">Why HQAdz</Link>
          <Link href="/pricing" className="hover:text-white transition-colors duration-150">Pricing</Link>
          <Link href="/how-it-works" className="hover:text-white transition-colors duration-150">How it works</Link>
          <Link href="/faq" className="hover:text-white transition-colors duration-150">FAQ</Link>
          <Link href="/telegram-session-management" className="hover:text-white transition-colors duration-150">Session management</Link>
          <Link href="/telegram-adbot-dashboard" className="hover:text-white transition-colors duration-150">Dashboard</Link>
          <Link href="/contact" className="hover:text-white transition-colors duration-150">Contact</Link>
        </nav>
      </div>
    </footer>
  );
}
