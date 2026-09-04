import { useState } from "react"

/**
 * The fields AddInstallation and EditInstallation both edit, name through
 * envVars. Neither page tracks a dirty flag today, so this hook doesn't
 * invent one.
 */
export interface InstallationFormFieldsValues {
  icon: IconType
  name: string
  version: GameVersionType | undefined
  startParams: string
  backupsLimit: number
  backupsAuto: boolean
  compressionLevel: number
  mesaGlThread: boolean
  envVars: string
  launchWrapper: string
}

export interface InstallationFormFields extends InstallationFormFieldsValues {
  setIcon: (icon: IconType) => void
  setName: (name: string) => void
  setVersion: (version: GameVersionType | undefined) => void
  setStartParams: (startParams: string) => void
  setBackupsLimit: (backupsLimit: number) => void
  setBackupsAuto: (backupsAuto: boolean) => void
  setCompressionLevel: (compressionLevel: number) => void
  setMesaGlThread: (mesaGlThread: boolean) => void
  setEnvVars: (envVars: string) => void
  setLaunchWrapper: (launchWrapper: string) => void
}

/**
 * Holds the fields shared by the Add and Edit Installation forms, each as its
 * own piece of state so a page can update one without touching the rest,
 * matching what both pages already did with individual `useState` calls.
 *
 * @param defaults The values each field starts at. AddInstallation seeds these
 * from the launcher's defaults; EditInstallation starts empty/zeroed and
 * fills them in once the Installation being edited is found.
 */
export function useInstallationFormFields(defaults: InstallationFormFieldsValues): InstallationFormFields {
  const [icon, setIcon] = useState<IconType>(defaults.icon)
  const [name, setName] = useState<string>(defaults.name)
  const [version, setVersion] = useState<GameVersionType | undefined>(defaults.version)
  const [startParams, setStartParams] = useState<string>(defaults.startParams)
  const [backupsLimit, setBackupsLimit] = useState<number>(defaults.backupsLimit)
  const [backupsAuto, setBackupsAuto] = useState<boolean>(defaults.backupsAuto)
  const [compressionLevel, setCompressionLevel] = useState<number>(defaults.compressionLevel)
  const [mesaGlThread, setMesaGlThread] = useState<boolean>(defaults.mesaGlThread)
  const [envVars, setEnvVars] = useState<string>(defaults.envVars)
  const [launchWrapper, setLaunchWrapper] = useState<string>(defaults.launchWrapper)

  return {
    icon,
    setIcon,
    name,
    setName,
    version,
    setVersion,
    startParams,
    setStartParams,
    backupsLimit,
    setBackupsLimit,
    backupsAuto,
    setBackupsAuto,
    compressionLevel,
    setCompressionLevel,
    mesaGlThread,
    setMesaGlThread,
    envVars,
    setEnvVars,
    launchWrapper,
    setLaunchWrapper
  }
}
