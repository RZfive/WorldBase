/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  async rewrites() {
    return [
      {
        source: "/.well-known/worldbase/capabilities",
        destination: "/api/worldbase/capabilities",
      },
    ];
  },
};

module.exports = nextConfig;
