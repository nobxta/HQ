import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

const SITE = "https://hqadz.io";
const TITLE = "HQAdz.io | Telegram AdBot Platform for Automated Posting";
const DESC =
  "HQAdz.io is a Telegram AdBot SaaS platform for managing automated Telegram ad posting, Telegram sessions, campaign logs, account health, and crypto payments from one dashboard.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: {
    default: TITLE,
    template: "%s | HQAdz",
  },
  description: DESC,
  keywords: [
    "Telegram ad bot",
    "Telegram advertising",
    "auto post Telegram groups",
    "crypto marketing bot",
    "Telegram marketing automation",
    "HQAdz",
    "HQAdz.io",
    "Telegram AdBot platform",
  ],
  applicationName: "HQAdz",
  alternates: { canonical: SITE },
  openGraph: {
    type: "website",
    url: SITE,
    siteName: "HQAdz",
    title: TITLE,
    description: DESC,
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESC,
  },
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
