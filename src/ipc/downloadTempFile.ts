/**
 * The download worker's temporary-file namespace, on its own so the orphan sweep in the main
 * process can read it without pulling the worker's HTTP and hashing code into the boot path.
 *
 * `src/main/orphanedTempFiles.ts` runs at main-process startup and only needs this string; the
 * module that writes the files it sweeps is loaded on demand.
 */

/** Namespace used by temporary download siblings and the orphan sweep. */
export const DOWNLOAD_TEMP_FILE_NAMESPACE = "riftlauncher"
