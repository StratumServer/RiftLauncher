import { createFileSystemPort } from "@renderer/adapters/fileSystem"

/** Deletes one installed mod's file or folder off disk. */
export function useDeleteInstalledModFile(): (path: string) => Promise<boolean> {
  const fileSystem = createFileSystemPort()
  return (path) => fileSystem.remove(path)
}
