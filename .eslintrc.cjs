module.exports = {
  root: true,
  extends: ["eslint:recommended", "plugin:react/recommended", "plugin:react/jsx-runtime", "@electron-toolkit/eslint-config-ts/recommended", "@electron-toolkit/eslint-config-prettier"],
  plugins: ["react-hooks"],
  rules: {
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "error"
  },
  overrides: [
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
      rules: {
        "react-hooks/exhaustive-deps": "warn"
      }
    }
  ]
}
