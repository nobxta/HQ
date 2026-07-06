"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { LayoutGrid, FileText, Users, User, Send } from "lucide-react";

const items = [
  { href: "/user/dashboard", label: "Overview", icon: LayoutGrid },
  { href: "/user/logs", label: "Logs", icon: FileText },
  { href: "/user/chatlist", label: "Groups", icon: Users },
  { href: "/user/settings", label: "Account", icon: User },
];

export default function MobileBottomNav() {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");

  return (
    <nav className="lg:hidden fixed inset-x-0 bottom-0 z-40 border-t border-white/[0.06] bg-dark-950/90 backdrop-blur-xl pb-[env(safe-area-inset-bottom)]">
      <div className="relative flex items-stretch justify-between px-2 pt-2 pb-1.5">
        {/* left two */}
        {items.slice(0, 2).map(({ href, label, icon: Icon }) => {
          const active = isActive(href);
          return (
            <Link key={href} href={href}
              className={cn("flex flex-1 flex-col items-center gap-1 py-1.5 transition-colors", active ? "text-accent" : "text-dark-500 hover:text-dark-300")}>
              <Icon className="h-[22px] w-[22px]" strokeWidth={active ? 2.4 : 2} />
              <span className="text-[10px] font-medium">{label}</span>
              {active && <span className="h-0.5 w-5 rounded-full bg-accent -mb-0.5" />}
            </Link>
          );
        })}

        {/* center FAB */}
        <Link href="/user/campaign" className="flex flex-1 flex-col items-center justify-start -mt-6" aria-label="Campaign">
          <span className="flex h-14 w-14 items-center justify-center rounded-full text-white shadow-lg"
            style={{ background: "linear-gradient(135deg, #8b6cff, #6c5ce7)", boxShadow: "0 8px 22px rgba(108,92,231,0.45)" }}>
            <Send className="h-6 w-6" />
          </span>
        </Link>

        {/* right two */}
        {items.slice(2).map(({ href, label, icon: Icon }) => {
          const active = isActive(href);
          return (
            <Link key={href} href={href}
              className={cn("flex flex-1 flex-col items-center gap-1 py-1.5 transition-colors", active ? "text-accent" : "text-dark-500 hover:text-dark-300")}>
              <Icon className="h-[22px] w-[22px]" strokeWidth={active ? 2.4 : 2} />
              <span className="text-[10px] font-medium">{label}</span>
              {active && <span className="h-0.5 w-5 rounded-full bg-accent -mb-0.5" />}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
