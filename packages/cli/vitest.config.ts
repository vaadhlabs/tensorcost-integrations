import { defineConfig } from "vitest/config";

const isIntegration = process.env["INTEGRATION"] === "1";

export default defineConfig({
  test: {
    environment: "node",
    // Default run (pnpm test) skips integration tests — they require a prior
    // `pnpm build` to produce dist/index.js. Set INTEGRATION=1 to include them
    // (or use `pnpm test:integration`).
    include: ["src/**/__tests__/**/*.test.ts"],
    exclude: isIntegration
      ? []
      : ["src/**/__tests__/**/*.integration.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/__tests__/**", "src/index.ts"],
    },
  },
});
