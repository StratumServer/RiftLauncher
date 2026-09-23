import js from "@eslint/js"
import globals from "globals"
import tseslint from "typescript-eslint"
import react from "eslint-plugin-react"
import reactHooks from "eslint-plugin-react-hooks"
import prettierConfig from "eslint-config-prettier"
import oxlint from "eslint-plugin-oxlint"

// Flat config replacing the .eslintrc.cjs this repository used under ESLint 8,
// which has been end of life since 2024-10-05. The two @electron-toolkit
// shareable configs it extended only ship the legacy format, so what they set is
// spelled out here instead: their env/parser/parserOptions block, their
// @typescript-eslint rule overrides, and their *.js carve-out for
// explicit-function-return-type. eslint-config-prettier stays (it stops ESLint
// from fighting Prettier); eslint-plugin-prettier does not, because
// `npm run format:check` already runs Prettier over the whole tree in the same
// CI job and reports the same problems as errors rather than warnings.

export default tseslint.config(
  // Was .eslintignore. `coverage` joins the list: `eslint .` walked into the
  // generated HTML report under ESLint 8 too, found nothing in it, and only
  // spent time doing so.
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "out/**",
      "coverage/**",
      // Violations on purpose, linted by tests/config/lint-guards.test.ts from a
      // copy it drops into the tree the rules actually target.
      "tests/fixtures/lint/**"
    ]
  },

  // `eslint .` with a flat config lints .js/.cjs/.mjs and nothing else unless a
  // config block names more, which is what the old `--ext` list did.
  {
    files: ["**/*.{js,jsx,cjs,mjs,ts,tsx,cts,mts}"],
    languageOptions: {
      // env: { browser: true, commonjs: true, es6: true, node: true }
      globals: { ...globals.browser, ...globals.commonjs, ...globals.node },
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: "module",
        ecmaVersion: 2021
      }
    },
    settings: {
      // eslint-plugin-react printed "React version not specified" on every run
      // under ESLint 8. Reading it off the installed react package silences that
      // and pins the version-dependent rules to what the app actually builds on.
      react: { version: "detect" }
    }
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  react.configs.flat.recommended,
  react.configs.flat["jsx-runtime"],
  prettierConfig,

  // The old config registered eslint-plugin-react-hooks and picked its two
  // rules by hand rather than extending a preset. Kept that way on purpose:
  // the plugin's v7 presets also switch on the whole React Compiler rule set
  // (set-state-in-effect, refs, purity and a dozen more), which is a separate
  // decision from moving off ESLint 8.
  { plugins: { "react-hooks": reactHooks } },

  // @electron-toolkit/eslint-config-ts/eslint-recommended
  {
    rules: {
      "@typescript-eslint/ban-ts-comment": ["error", { "ts-ignore": "allow-with-description" }],
      "@typescript-eslint/explicit-function-return-type": "error",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-empty-function": ["error", { allow: ["arrowFunctions"] }],
      "@typescript-eslint/no-empty-interface": ["error", { allowSingleExtends: true }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "off",
      // The toolkit config turned no-var-requires off so the CommonJS helpers in
      // scripts/ could keep calling require(). typescript-eslint 8 folded that
      // rule into no-require-imports and put the successor in `recommended`, so
      // the same carve-out now has to name the new rule to stay off.
      "@typescript-eslint/no-var-requires": "off",
      "@typescript-eslint/no-require-imports": "off",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error"
    }
  },
  {
    files: ["**/*.js"],
    rules: { "@typescript-eslint/explicit-function-return-type": "off" }
  },
  {
    // @electron-toolkit/eslint-config-ts turns explicit-function-return-type off for plain
    // *.js (see its eslint-recommended.js), which is why scripts/fix-native-deps.js and its
    // siblings never had to annotate every function. The headless tooling is .mjs, for the
    // top-level await its CDP driver and seed script both need, so it falls outside that
    // built-in carve-out and needs the same relief spelled out here instead.
    files: ["scripts/headless/**/*.mjs"],
    rules: { "@typescript-eslint/explicit-function-return-type": "off" }
  },
  {
    // src/domain holds pure business logic. It reaches the outside world only
    // through the ports in src/domain/ports.ts, never through a host API.
    files: ["src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "electron", message: "src/domain must stay free of Electron. Add a port instead." },
            { name: "fs", message: "src/domain must stay free of Node. Use the FileSystem port." },
            { name: "fs/promises", message: "src/domain must stay free of Node. Use the FileSystem port." },
            { name: "fs-extra", message: "src/domain must stay free of Node. Use the FileSystem port." },
            { name: "path", message: "src/domain must stay free of Node. Use the PathBuilder port." },
            { name: "child_process", message: "src/domain must stay free of Node. Add a port instead." },
            { name: "react", message: "src/domain must stay free of React." },
            { name: "react-dom", message: "src/domain must stay free of React." }
          ],
          patterns: [
            { group: ["node:*"], message: "src/domain must stay free of Node built-ins. Add a port instead." },
            { group: ["electron/*"], message: "src/domain must stay free of Electron. Add a port instead." },
            { group: ["@renderer/*", "@src/ipc/*"], message: "src/domain must not depend on the renderer or the IPC layer." }
          ]
        }
      ]
    }
  },

  // Everything .oxlintrc.json enforces is switched off here, so the two linters
  // never report the same problem twice. One block is dropped on the way in,
  // by name rather than by the presence of an `ignores` key: two of the six
  // blocks carry one, and dropping both kept no-unused-vars and
  // rules-of-hooks enabled on this side while oxlint already denies them.
  ...oxlint
    .buildFromOxlintConfigFile(".oxlintrc.json")
    // oxlint skips src/global.d.ts because its own parser trips over an ambient
    // `declare` that tsc accepts, and that is no reason for ESLint to stop
    // reading the file.
    .filter((config) => config.name !== "oxlint/oxlint-config-ignore-patterns"),

  // oxlint's typescript/explicit-function-return-type only fires on TypeScript
  // files, so handing the rule over wholesale would drop it for .jsx, .cjs and
  // .mjs. The old config exempted plain *.js and nothing else, so ESLint keeps
  // the rule for the extensions oxlint cannot reach.
  {
    files: ["**/*.{jsx,cjs,mjs}"],
    ignores: ["scripts/headless/**/*.mjs"],
    rules: { "@typescript-eslint/explicit-function-return-type": "error" }
  },

  // The price of splitting the rules across two linters: an inline
  // `eslint-disable-next-line @typescript-eslint/no-explicit-any` now silences
  // a rule ESLint no longer runs, and ESLint 9 turns unused-directive reporting
  // on by default, so it would flag five of them. oxlint has the mirror problem
  // with the exhaustive-deps directives in ListMods.tsx. Neither linter can
  // judge a directive it does not own, so the check is off on both sides.
  { linterOptions: { reportUnusedDisableDirectives: "off" } },

  // react-hooks/exhaustive-deps is the one rule kept on this side, so it comes
  // back after the block above. oxlint reports the same 13 files but 15
  // findings at different lines, and "the 14 known warnings" is the number this
  // repository reads its lint output against.
  { rules: { "react-hooks/exhaustive-deps": "error" } },
  {
    // Pre-existing exhaustive-deps violations from before this rule was turned on (21
    // total, measured with a one-off trial install against this exact tree). Each is a
    // real gap, not a false positive, but fixing 21 dependency arrays across 13 files
    // sight-unseen risks introducing the exact stale-closure bugs this rule exists to
    // catch elsewhere in the app. Downgraded to a warning here so lint:ci stays green
    // without silencing the rule everywhere; ListMods.tsx is deliberately left off this
    // list; its 3 violations are handled with inline disable comments and reasons instead,
    // since that file was already being touched by this same change.
    files: [
      "src/renderer/src/components/layout/GlobalModUpdateChecker.tsx",
      "src/renderer/src/components/ui/StickyMenu.tsx",
      "src/renderer/src/contexts/NotificationsContext.tsx",
      "src/renderer/src/features/config/contexts/ConfigContext.tsx",
      "src/renderer/src/features/installations/pages/AddInstallation.tsx",
      "src/renderer/src/features/installations/pages/EditInstallation.tsx",
      "src/renderer/src/features/launch/hooks/useNotifyOnPreventedAppClose.ts",
      "src/renderer/src/features/mods/components/InstallModPopup.tsx",
      "src/renderer/src/features/mods/components/OrderFilter.tsx",
      "src/renderer/src/features/mods/hooks/useManageInstalledMods.ts",
      "src/renderer/src/features/mods/hooks/useModDbLookups.ts",
      "src/renderer/src/features/versions/hooks/useVersionInstallFolder.ts",
      "src/renderer/src/features/versions/pages/AddVersion.tsx"
    ],
    rules: { "react-hooks/exhaustive-deps": "warn" }
  }
)
