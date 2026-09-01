import { join } from "node:path"
import { pathToFileURL } from "node:url"
import fse from "fs-extra"

import { IconMemoryCache, readIconWithMemoryCache } from "@domain/mods/iconMemoryCache"
import { resolveContainedPath } from "@src/ipc/validation"

export type CacheModImageProtocolPorts = {
  cache: IconMemoryCache
  getUserDataPath: () => string
  fetchFile: (url: string) => Promise<Response>
}

/** The image types served out of the mod icon cache, and the Content-Type each is served under. */
const MOD_IMAGE_CONTENT_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" }

export function createCacheModImageProtocolHandler({ cache, getUserDataPath, fetchFile }: CacheModImageProtocolPorts): (request: Request) => Promise<Response> {
  return async (request) => {
    const srcPath = join(getUserDataPath(), "Cache", "Images", "Mods")
    const filePath = resolveContainedPath(srcPath, new URL(request.url).pathname)
    if (!filePath) return new Response(null, { status: 404 })

    const dot = filePath.lastIndexOf(".")
    const contentType = dot === -1 ? undefined : MOD_IMAGE_CONTENT_TYPES[filePath.slice(dot).toLowerCase()]
    if (!contentType) return new Response(null, { status: 404 })
    if (!(await isSafeProtocolFile(filePath))) return new Response(null, { status: 404 })

    try {
      const bytes = await readIconWithMemoryCache(cache, filePath, async () => {
        const response = await fetchFile(pathToFileURL(filePath).toString())
        if (!response.ok) throw new Error(`Failed to read icon: ${response.status}`)
        return Buffer.from(await response.arrayBuffer())
      })
      // Copy the cached bytes before handing them to Response so a transferred or detached body cannot affect the shared cache Buffer.
      return new Response(new Uint8Array(bytes), { headers: { "Content-Type": contentType, "Content-Length": String(bytes.length) } })
    } catch {
      return new Response(null, { status: 404 })
    }
  }
}

export type BackgroundProtocolPorts = {
  getUserDataPath: () => string
  fetchFile: (url: string) => Promise<Response>
}

/**
 * Serves the background the player chose out of userData/Cache/Backgrounds.
 *
 * Same shape as {@link createCacheModImageProtocolHandler} and same order of checks: containment
 * first, then the extension gate, then the file-system safety check, and only then a read. What is
 * deliberately missing is the memory cache. Mod icons are content-addressed, so a hit can never be
 * stale; the custom background keeps one stable name whose bytes are replaced whenever the player
 * picks another picture, and a cache keyed on that name would serve the old one forever.
 */
export function createBackgroundProtocolHandler({ getUserDataPath, fetchFile }: BackgroundProtocolPorts): (request: Request) => Promise<Response> {
  return async (request) => {
    const srcPath = join(getUserDataPath(), "Cache", "Backgrounds")
    const filePath = resolveContainedPath(srcPath, new URL(request.url).pathname)
    if (!filePath || !filePath.toLowerCase().endsWith(".jpg")) return new Response(null, { status: 404 })
    if (!(await isSafeProtocolFile(filePath))) return new Response(null, { status: 404 })

    try {
      const response = await fetchFile(pathToFileURL(filePath).toString())
      if (!response.ok) throw new Error(`Failed to read background: ${response.status}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      // Copy the bytes before handing them to Response so a transferred or detached body cannot reach back into the Buffer this read produced.
      return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/jpeg", "Content-Length": String(bytes.length) } })
    } catch {
      return new Response(null, { status: 404 })
    }
  }
}

export async function isSafeProtocolFile(filePath: string): Promise<boolean> {
  try {
    const stats = await fse.lstat(filePath)
    if (!stats.isFile() || stats.isSymbolicLink()) return false
    const realPath = await fse.realpath(filePath)
    return realPath === filePath || (process.platform === "win32" && realPath.toLowerCase() === filePath.toLowerCase())
  } catch {
    return false
  }
}
