import type { IpcMainEvent } from "electron"

import { IconMemoryCache } from "@domain/mods/iconMemoryCache"

export function clearModIconMemoryCache(cache: IconMemoryCache): void {
  cache.clear()
}

export function createClearModIconMemoryCacheHandler(cache: IconMemoryCache, isTrusted: (event: IpcMainEvent) => boolean): (event: IpcMainEvent) => void {
  return (event) => {
    if (!isTrusted(event)) return
    clearModIconMemoryCache(cache)
  }
}
