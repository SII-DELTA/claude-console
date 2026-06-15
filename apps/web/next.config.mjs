/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  distDir: process.env.NEXT_DIST_DIR || ".next",
  transpilePackages: ["@mac/shared"],
  experimental: {
    typedRoutes: false,
  },
};
