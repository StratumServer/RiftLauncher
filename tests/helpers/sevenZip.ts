import { accessSync, chmodSync, constants } from "node:fs"
import { path7za } from "7zip-bin"

/**
 * The bundled 7-Zip binary, made runnable.
 *
 * `npm ci` does not always restore the executable bit on it, so a plain test
 * run can hit EACCES on a machine where nothing is wrong with the checkout.
 * The packaged application does not care: electron-builder sets the bit when it
 * lays the binary into the app image.
 */
export function runnableSevenZip(): string {
  try {
    accessSync(path7za, constants.X_OK)
  } catch {
    chmodSync(path7za, 0o755)
  }
  return path7za
}
