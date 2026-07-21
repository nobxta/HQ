import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

const SITE = "https://hqadz.io";
const TITLE = "HQAdz | Telegram AdBot Platform for Automated Posting";
const DESC =
  "HQAdz is a Telegram advertising platform for launching campaigns, managing posting bots, selecting groups and tracking every delivery in real time.";

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
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-32x32.png", type: "image/png", sizes: "32x32" },
      { url: "/favicon-16x16.png", type: "image/png", sizes: "16x16" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
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
