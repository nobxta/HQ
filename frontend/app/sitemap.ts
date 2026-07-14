import type { MetadataRoute } from "next";

const baseUrl = "https://hqadz.io";

// Stable per-route lastmod dates. Bump the date for a route ONLY when that
// page's meaningful content changes, so the sitemap does not churn on every
// deploy. changefreq/priority are intentionally omitted — Google ignores them.
const routes: { path: string; lastModified: string }[] = [
  { path: "", lastModified: "2026-07-13" },
  { path: "/telegram-adbot", lastModified: "2026-07-09" },
  { path: "/features", lastModified: "2026-07-14" },
  { path: "/why-hqadz", lastModified: "2026-07-14" },
  { path: "/pricing", lastModified: "2026-07-09" },
  { path: "/how-it-works", lastModified: "2026-07-09" },
  { path: "/faq", lastModified: "2026-07-14" },
  { path: "/telegram-session-management", lastModified: "2026-07-09" },
  { path: "/telegram-adbot-dashboard", lastModified: "2026-07-09" },
  { path: "/contact", lastModified: "2026-07-14" },
  { path: "/privacy-policy", lastModified: "2026-07-09" },
  { path: "/terms", lastModified: "2026-07-09" },
];

export default function sitemap(): MetadataRoute.Sitemap {
  return routes.map(({ path, lastModified }) => ({
    url: `${baseUrl}${path}`,
    lastModified,
  }));
}
