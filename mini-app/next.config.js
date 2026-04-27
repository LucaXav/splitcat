/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // The Telegram Mini App is loaded inside an iframe; this avoids issues.
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // Telegram needs to embed us
          { key: "Content-Security-Policy", value: "frame-ancestors 'self' https://*.telegram.org https://web.telegram.org" }
        ]
      }
    ];
  }
};
module.exports = nextConfig;
