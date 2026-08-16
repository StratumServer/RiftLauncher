import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/domain/**", "src/ipc/**", "src/utils/**", "src/config/**"],
      thresholds: {
        lines: 33,
        statements: 33,
        functions: 33,
        branches: 38
      }
    }
  }
})
