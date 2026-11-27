import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

import { existsSync } from "node:fs";

import { attendanceFixture } from "./uji/attendance-fixture.mjs";

/**
 * UJI_KEHADIRAN=1, or the untracked marker file `uji/aktif`, answers /api from a synthetic
 * fixture for design evidence of /app/attendance. While it is on, the dev server binds to
 * loopback and the proxy to the real API is removed, so it cannot reach any real backend.
 * Never reachable from a build: this only touches the dev server.
 */
const fixtureOn = process.env.UJI_KEHADIRAN === "1" || existsSync(new URL("./uji/aktif", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss(), tsconfigPaths(), ...(fixtureOn ? [attendanceFixture()] : [])],
  server: {
    host: fixtureOn ? "127.0.0.1" : "0.0.0.0",
    proxy: fixtureOn ? undefined : {
      "/api": {
        target: process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:3001",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
