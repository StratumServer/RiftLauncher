import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/domain/**", "src/ipc/**", "src/utils/**", "src/config/**"],
      thresholds: {
        lines: 17,
        statements: 17,
        functions: 20,
        branches: 22
      }
    }
  }
})
