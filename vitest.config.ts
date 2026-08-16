import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/domain/**", "src/ipc/**", "src/utils/**", "src/config/**"],
      thresholds: {
        lines: 15,
        statements: 16,
        functions: 18,
        branches: 20
      }
    }
  }
})
