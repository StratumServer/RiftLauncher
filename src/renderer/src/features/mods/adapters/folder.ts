import { modsFolder } from "@domain/mods/folder"
import { createPathBuilderPort } from "@renderer/adapters/paths"

/** The Mods folder of an installation, for every flow that has to point at it. */
export function resolveModsFolder(installationPath: string): Promise<string> {
  return modsFolder(createPathBuilderPort(), installationPath)
}
