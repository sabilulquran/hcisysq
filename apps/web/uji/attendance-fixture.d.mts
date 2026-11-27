import type { PluginOption } from "vite";

/** Dev-only middleware that answers /api with synthetic attendance data. See the .mjs for why. */
export function attendanceFixture(): PluginOption;
