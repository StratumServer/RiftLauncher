module.exports = {
  root: true,
  extends: ["eslint:recommended", "plugin:react/recommended", "plugin:react/jsx-runtime", "@electron-toolkit/eslint-config-ts/recommended", "@electron-toolkit/eslint-config-prettier"],
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
    }
  ]
}
