import { join } from "node:path"

import fse from "fs-extra"

/**
 * Reads electron-builder's `package-type` marker next to the packaged app, when the deb,
 * rpm or pacman targets wrote one. Its absence just means an AppImage, a flatpak, or a dev
 * run, all of which canAutoUpdate treats the same as "no marker".
 *
 * Lives in its own module because the boot-time portable decision needs it too, and that one
 * has to run before the entry imports anything else.
 */
export function readLinuxPackageType(): string | undefined {
  try {
    const markerPath = join(process.resourcesPath, "package-type")
    if (!fse.existsSync(markerPath)) return undefined
    return fse.readFileSync(markerPath, "utf-8").trim()
  } catch {
    return undefined
  }
}
