import { useSyncExternalStore } from "react"

/** The busy key of a download on its way into one Installation's Mods folder, by the modid it writes. */
export function modWriteKey(installationId: string, modid: string): string {
  return `write:${installationId}:${modid.toLowerCase()}`
}

/*
 * Downloads in flight, by modWriteKey. Kept outside any one page because a download outlives the page
 * that started it. The old archive of an update stays listed and actionable until the new one has
 * landed, and a fresh page has an empty busy set, so this is what it asks instead: a second install,
 * a toggle or a delete of a Mod whose key is held would race the swap and lose a version of it.
 */
const modWrites = new Set<string>()
const modWriteListeners = new Set<() => void>()
let modWritesSnapshot: readonly string[] = []

export function subscribeModWrites(listener: () => void): () => void {
  modWriteListeners.add(listener)
  return () => modWriteListeners.delete(listener)
}

export function getModWritesSnapshot(): readonly string[] {
  return modWritesSnapshot
}

/** Subscribes a component to the current set of in-flight Mod write keys. */
export function useModWrites(): readonly string[] {
  return useSyncExternalStore(subscribeModWrites, getModWritesSnapshot)
}

/** True while a download of this Mod is on its way into this Installation's Mods folder. */
export function isModWriting(installationId: string, modid: string): boolean {
  return modWrites.has(modWriteKey(installationId, modid))
}

function publishModWrites(): void {
  modWritesSnapshot = [...modWrites]
  for (const listener of modWriteListeners) listener()
}

/** Claims every key or none, so two writes of one Mod into one folder never overlap. */
export function claimModWrites(keys: readonly string[]): boolean {
  if (keys.some((key) => modWrites.has(key))) return false
  for (const key of keys) modWrites.add(key)
  publishModWrites()
  return true
}

export function releaseModWrites(keys: readonly string[]): void {
  for (const key of keys) modWrites.delete(key)
  publishModWrites()
}
