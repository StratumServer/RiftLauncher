import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/domain/**", "src/ipc/**", "src/utils/**", "src/config/**"],
      thresholds: {
        lines: 34,
        statements: 35,
        functions: 37,
        branches: 41
      }
    }
  }
})
