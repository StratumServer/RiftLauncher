import { useEffect, useState } from "react"

export interface AppInfo {
  /** Launcher version, e.g. "1.6.1". Empty until the async read resolves. */
  vslVersion: string
  /** Host OS, straight off Node's `process.platform`. Empty until the async read resolves. */
  os: string
  /** Absolute path to the launcher's Logs folder. Empty until the async read resolves. */
  logsFolder: string
  /** Opens `logsFolder` on the OS file explorer. */
  openLogsFolder: () => void
}

/** Launcher version, OS, and logs folder path/opener for the Info & Help page's debug section. */
export function useAppInfo(): AppInfo {
  const [vslVersion, setVslVersion] = useState("")
  const [os, setOs] = useState("")
  const [logsFolder, setLogsFolder] = useState("")

  useEffect(() => {
    ;(async (): Promise<void> => {
      setVslVersion(await window.api.utils.getAppVersion())
      setOs(await window.api.utils.getOs())
      setLogsFolder(await window.api.pathsManager.formatPath([await window.api.pathsManager.getCurrentUserDataPath(), "Logs"]))
    })()
  }, [])

  return {
    vslVersion,
    os,
    logsFolder,
    openLogsFolder: (): void => {
      window.api.pathsManager.openPathOnFileExplorer(logsFolder)
    }
  }
}
