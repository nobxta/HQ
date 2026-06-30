import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/admin", "/user", "/api", "/login"] },
    sitemap: "https://www.hqadz.io/sitemap.xml",
    host: "https://www.hqadz.io",
  };
}
