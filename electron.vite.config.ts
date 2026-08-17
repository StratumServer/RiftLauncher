import { resolve } from "path"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import react from "@vitejs/plugin-react"
import type { Plugin } from "vite"

/**
 * The renderer CSP in src/renderer/index.html is the strict policy that ships: style-src stays
 * 'self', so nothing can smuggle styles in through an injected <style> tag or a style attribute.
 * The vite dev server, however, hands the compiled Tailwind sheet to the page as an inline
 * <style> tag so it can hot reload it, and that policy blocks it, leaving the dev window
 * completely unstyled. This plugin adds 'unsafe-inline' back for `electron-vite dev` only.
 *
 * The relaxation lives here rather than in index.html on purpose. The file on disk holds the
 * strict policy, so if this plugin ever stops matching, dev styling breaks loudly while the
 * build stays locked down, instead of the build quietly shipping a permissive policy.
 */
function allowInlineStylesOnDevServer(): Plugin {
  return {
    name: "riftlauncher:dev-server-inline-styles",
    apply: "serve",
    transformIndexHtml(html): string {
      return html.replace(/style-src ([^;"]+)/, "style-src $1 'unsafe-inline'")
    }
  }
}

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
    plugins: [react(), allowInlineStylesOnDevServer()]
  }
})
