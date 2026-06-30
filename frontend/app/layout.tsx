import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

const SITE = "https://www.hqadz.io";
const DESC =
  "HQAdz runs automated Telegram ad bots that post your message across thousands of groups on a schedule. Pick a plan, pay in crypto, and your AdBot goes live in minutes.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: {
    default: "HQAdz — Automated Telegram AdBot for Crypto & Web3 Marketing",
    template: "%s · HQAdz",
  },
  description: DESC,
  keywords: [
    "Telegram ad bot",
    "Telegram advertising",
    "auto post Telegram groups",
    "crypto marketing bot",
    "Telegram marketing automation",
    "HQAdz",
  ],
  applicationName: "HQAdz",
  alternates: { canonical: SITE },
  openGraph: {
    type: "website",
    url: SITE,
    siteName: "HQAdz",
    title: "HQAdz — Automated Telegram AdBot",
    description: DESC,
  },
  twitter: {
    card: "summary_large_image",
    title: "HQAdz — Automated Telegram AdBot",
    description: DESC,
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
