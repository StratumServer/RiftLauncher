import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/ipc/**", "src/utils/**", "src/config/**"],
      thresholds: {
        lines: 7,
        statements: 8,
        functions: 11,
        branches: 13
      }
    }
  }
})
