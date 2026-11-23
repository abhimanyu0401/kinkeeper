import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  allowedDevOrigins: [
    "localhost",
    "localhost:3000",
    "127.0.0.1",
    "127.0.0.1:3000",
    "192.168.162.74",
    "192.168.162.74:3000",
    "172.16.47.48",
    "172.16.47.48:3000",
    "192.168.1.4",
    "192.168.1.4:3000",
    "192.168.0.103",
    "172.18.2.89",
    "172.20.10.0"
  ],
};

export default nextConfig;
