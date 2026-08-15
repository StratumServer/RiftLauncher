/**
 * Strips characters a folder name cannot carry and collapses the leftovers into
 * single dashes.
 *
 * @param folderName Raw name, typically typed by the user.
 * @returns The sanitised name, possibly empty.
 */
export function cleanFolderName(folderName: string): string {
  return folderName
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}
