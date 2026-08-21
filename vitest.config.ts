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
          include: ["tests/**/*.test.ts"],
          setupFiles: ["tests/setup-node.ts"]
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
      // Default reporters (text, html, clover, json) plus lcov for SonarCloud.
      reporter: ["text", "html", "clover", "json", "lcov"],
      // Renderer logic joins the ratchet here (#17): hooks, adapters, the
      // config context/reducer, and plain utils. Presentation stays out on
      // purpose (pages/**, components/**, App.tsx, main.tsx, i18n.ts): the
      // DOM harness exercises it through behavior, but line-covering JSX is
      // theater, not a signal worth gating on.
      include: [
        "src/domain/**",
        "src/main/**",
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
      // src/main joined the instrumented set so files like the userData
      // migration adapter report real numbers to the ratchet and to Sonar
      // (uninstrumented lines read as uncovered there, failing PR gates on
      // tested code). index.ts stays out for the same reason main.tsx does
      // renderer-side: it is process bootstrap, exercised by launching the
      // app, not by line-covering wiring.
      exclude: ["src/main/index.ts"],
      // Raised by the worker/account-storage pass, the win32 RUN_INSTALLER /
      // utilsHandlers / TaskManagerContext pass, and the Inno domain / config
      // pass (script.ts, extract.ts, lzma.ts, configManager.ts,
      // configReducer.ts) together: measured repo-wide coverage with all
      // three is ~90.95/89.49/87/86.92 (lines/statements/functions/branches);
      // floors sit a couple of points under each, the same buffer every
      // previous set of floors kept below its own measured numbers.
      thresholds: {
        lines: 89,
        statements: 87,
        functions: 85,
        branches: 85
      }
    }
  }
})
