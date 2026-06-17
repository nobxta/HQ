/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: "",
  async rewrites() {
    return [
      {
        source: "/api/backend/:path*",
        destination: `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api/:path*`,
      },
      {
        source: "/coin-img/:path*",
        destination: "https://coin-images.coingecko.com/:path*",
      },
    ];
  },
};
module.exports = nextConfig;
