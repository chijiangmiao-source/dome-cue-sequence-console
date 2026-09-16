/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.API_PROXY_TARGET ?? "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": apiTarget },
  },
  preview: {
    proxy: { "/api": apiTarget },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
