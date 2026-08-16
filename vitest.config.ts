import { resolve } from "path"
import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["tests/**/*.test.ts"]
        }
      },
      {
        extends: true,
        plugins: [react()],
        resolve: {
          alias: {
            "@renderer": resolve(__dirname, "src/renderer/src"),
            "@domain": resolve(__dirname, "src/domain")
          }
        },
        test: {
          name: "renderer-dom",
          environment: "jsdom",
          include: ["tests/renderer-dom/**/*.test.tsx"],
          setupFiles: ["tests/renderer-dom/setup.ts"]
        }
      }
    ],
    coverage: {
      provider: "v8",
      // Renderer components stay out of the ratchet for now: this slice only
      // adds the harness to mount them, not the coverage. Widening this to
      // include src/renderer lands with the actual ConfigContext split (#17).
      include: ["src/domain/**", "src/ipc/**", "src/utils/**", "src/config/**"],
      thresholds: {
        lines: 42,
        statements: 43,
        functions: 45,
        branches: 51
      }
    }
  }
})
