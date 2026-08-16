import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/domain/**", "src/ipc/**", "src/utils/**", "src/config/**"],
      thresholds: {
        lines: 39,
        statements: 39,
        functions: 43,
        branches: 46
      }
    }
  }
})
