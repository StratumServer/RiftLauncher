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

export function createCacheModImageProtocolHandler({ cache, getUserDataPath, fetchFile }: CacheModImageProtocolPorts): (request: Request) => Promise<Response> {
  return async (request) => {
    const srcPath = join(getUserDataPath(), "Cache", "Images", "Mods")
    const filePath = resolveContainedPath(srcPath, new URL(request.url).pathname)
    if (!filePath || !filePath.toLowerCase().endsWith(".png")) return new Response(null, { status: 404 })
    if (!(await isSafeProtocolFile(filePath))) return new Response(null, { status: 404 })

    try {
      const bytes = await readIconWithMemoryCache(cache, filePath, async () => {
        const response = await fetchFile(pathToFileURL(filePath).toString())
        if (!response.ok) throw new Error(`Failed to read icon: ${response.status}`)
        return Buffer.from(await response.arrayBuffer())
      })
      return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/png", "Content-Length": String(bytes.length) } })
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
