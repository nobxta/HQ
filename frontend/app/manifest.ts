import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "HQAdz — Telegram AdBot Platform",
    short_name: "HQAdz",
    description:
      "Launch Telegram ad campaigns, manage posting bots, and track every delivery in real time.",
    start_url: "/",
    display: "standalone",
    background_color: "#0b0b12",
    theme_color: "#7657ff",
    icons: [
      { src: "/android-chrome-192x192.png", sizes: "192x192", type: "image/png" },
      { src: "/android-chrome-512x512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
