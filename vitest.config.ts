import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
    // Keep real stylesheet text for the ?raw imports in css-collisions.test.ts.
    css: { include: /.+/ },
  },
});
