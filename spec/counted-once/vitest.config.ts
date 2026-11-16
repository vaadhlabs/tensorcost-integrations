import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["same-call.spec.ts"] },
});
