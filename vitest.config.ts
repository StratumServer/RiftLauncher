import { resolve } from "path"
import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        resolve: {
          alias: {
            "@src": resolve(__dirname, "src"),
            "@domain": resolve(__dirname, "src/domain")
          }
        },
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
      // Renderer logic joins the ratchet here (#17): hooks, adapters, the
      // config context/reducer, and plain utils. Presentation stays out on
      // purpose (pages/**, components/**, App.tsx, main.tsx, i18n.ts): the
      // DOM harness exercises it through behavior, but line-covering JSX is
      // theater, not a signal worth gating on.
      include: [
        "src/domain/**",
        "src/ipc/**",
        "src/utils/**",
        "src/config/**",
        "src/renderer/src/adapters/**",
        "src/renderer/src/hooks/**",
        "src/renderer/src/utils/**",
        "src/renderer/src/contexts/**",
        "src/renderer/src/features/**/hooks/**",
        "src/renderer/src/features/**/adapters/**",
        "src/renderer/src/features/config/contexts/**",
        "src/renderer/src/features/config/utils/**"
      ],
      // Raised by the main-process handler branch-coverage campaign: measured
      // repo-wide coverage after that pass was ~78.3/75.8/77.3/70.2
      // (lines/statements/functions/branches); floors sit a couple of points
      // under each, the same buffer the previous floors kept below their own
      // measured numbers.
      thresholds: {
        lines: 77,
        statements: 74,
        functions: 76,
        branches: 69
      }
    }
  }
})
