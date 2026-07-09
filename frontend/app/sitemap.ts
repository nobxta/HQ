import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = "https://hqadz.io";
  const lastModified = new Date();

  const routes = [
    "",
    "/telegram-adbot",
    "/features",
    "/pricing",
    "/how-it-works",
    "/telegram-session-management",
    "/telegram-adbot-dashboard",
    "/contact",
    "/privacy-policy",
    "/terms"
  ];

  return routes.map((route) => ({
    url: `${baseUrl}${route}`,
    lastModified,
    changeFrequency: route === "" ? "weekly" : "monthly",
    priority: route === "" ? 1 : 0.8,
  }));
}
