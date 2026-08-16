import { resolve } from "path"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { "@src": resolve(__dirname, "src"), "@domain": resolve(__dirname, "src/domain") } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { "@src": resolve(__dirname, "src"), "@domain": resolve(__dirname, "src/domain") } }
  },
  renderer: {
    build: {
      rollupOptions: {
        external: ["*.json"]
      }
    },
    resolve: {
      alias: {
        "@renderer": resolve(__dirname, "src/renderer/src"),
        "@domain": resolve(__dirname, "src/domain")
      }
    },
    plugins: [react()]
  }
})
