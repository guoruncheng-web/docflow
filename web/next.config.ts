import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Needed by the Dockerfile; Vercel ignores it and uses its own output.
  output: "standalone",

  // Next walks up looking for a lockfile to decide what to trace. A stray
  // package-lock.json in a parent directory makes it pick the wrong root and
  // then fail to resolve this app's own pages, so the root is pinned here.
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
