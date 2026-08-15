import { cleanFolderName as clean } from "@domain/naming"

export function useCleanFolderName(): ({ folderName }: { folderName: string }) => Promise<string> {
  /**
   * Removes invalid characters from a folder name and replaces spaces with dashes.
   *
   * @param {object} props
   * @param {string} [props.folderName] Folder name to clean.
   * @returns {Promise<string>}
   */
  async function cleanFolderName({ folderName }: { folderName: string }): Promise<string> {
    return clean(folderName)
  }

  return cleanFolderName
}
