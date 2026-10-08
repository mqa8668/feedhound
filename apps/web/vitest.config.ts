import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// DOM unit tests. The bun:test files
// (src/lib/format.test.ts, src/components/layout/DataTable.test.tsx) run under
// `bun test` via the package `test` script, never under vitest.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["src/lib/format.test.ts", "src/components/layout/DataTable.test.tsx"],
  },
});
