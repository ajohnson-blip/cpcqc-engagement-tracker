/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    typedRoutes: false,
  },
  async rewrites() {
    return [
      {
        // Proxy API calls to the backend during local dev to avoid CORS friction.
        source: '/api/:path*',
        destination: `${process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3001'}/:path*`,
      },
    ];
  },
};

export default nextConfig;
