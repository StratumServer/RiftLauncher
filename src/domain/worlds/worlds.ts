export const SAVES_FOLDER_NAME = "Saves"
export const WORLD_FILE_EXTENSION = ".vcdbs"
export const DEFAULT_WORLD_FILE_NAME = `default${WORLD_FILE_EXTENSION}`
export const MAX_WORLDS = 1_000
export const WORLD_SIDECAR_SUFFIXES = ["-wal", "-shm"] as const

export interface WorldFileEntry {
  name: string
  size: number
  lastModified: number
  isDefault: boolean
  backupCount: number
}

export function isSafeWorldName(name: unknown): name is string {
  if (typeof name !== "string") return false
  const stem = name.slice(0, -WORLD_FILE_EXTENSION.length)
  const reservedDeviceName = /^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i
  const hasControlCharacter = Array.from(name).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
  return (
    name.length > WORLD_FILE_EXTENSION.length &&
    name.length <= 255 &&
    name.toLowerCase().endsWith(WORLD_FILE_EXTENSION) &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    !hasControlCharacter &&
    !/[ .]$/u.test(name) &&
    !reservedDeviceName.test(stem)
  )
}

export function worldSidecarNames(name: string): string[] {
  return WORLD_SIDECAR_SUFFIXES.map((suffix) => `${name}${suffix}`)
}

export function hasWorldSidecars(names: readonly string[], worldName: string): boolean {
  const entries = new Set(names.map((name) => name.toLocaleLowerCase("en-US")))
  return worldSidecarNames(worldName).some((name) => entries.has(name.toLocaleLowerCase("en-US")))
}

export function listWorlds(entries: readonly WorldFileEntry[]): WorldFileEntry[] {
  return entries
    .filter((entry) => isSafeWorldName(entry.name) && Number.isFinite(entry.size) && Number.isFinite(entry.lastModified))
    .sort((left, right) => right.lastModified - left.lastModified || left.name.localeCompare(right.name))
    .slice(0, MAX_WORLDS)
}

export function collisionFreeWorldName(name: string, existingNames: readonly string[]): string {
  const existing = new Set(existingNames.map((entry) => entry.toLocaleLowerCase("en-US")))
  if (!existing.has(name.toLocaleLowerCase("en-US"))) return name
  const lower = WORLD_FILE_EXTENSION.length
  const stem = name.slice(0, -lower)
  for (let suffix = 2; suffix <= MAX_WORLDS + 1; suffix++) {
    const candidate = `${stem} (${suffix})${WORLD_FILE_EXTENSION}`
    if (!existing.has(candidate.toLocaleLowerCase("en-US"))) return candidate
  }
  throw new Error("No available world name")
}

export function worldVersionWarning(sourceVersion: string, targetVersion: string): "different-version" | undefined {
  return sourceVersion !== targetVersion ? "different-version" : undefined
}

export function canTransferWorld(sourceInstallationId: string, targetInstallationId: string): boolean {
  return sourceInstallationId !== targetInstallationId
}
