import { ipcMain } from "electron"
import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { assertTrustedIpcSender } from "@src/ipc/ipcSecurity"
import { isRecord } from "@src/ipc/validation"
import { assertConfigPathsAuthorized } from "@src/ipc/pathPolicy"

import { getConfig, normalizeConfig, saveConfig } from "@src/config/configManager"

ipcMain.handle(IPC_CHANNELS.CONFIG_MANAGER.GET_CONFIG, async (event): Promise<ConfigType> => {
  assertTrustedIpcSender(event)
  return await getConfig()
})

ipcMain.handle(IPC_CHANNELS.CONFIG_MANAGER.SAVE_CONFIG, async (event, config: ConfigType) => {
  assertTrustedIpcSender(event)
  if (!isRecord(config)) return false
  const normalizedConfig = normalizeConfig(config)
  const currentConfig = await getConfig()
  if (!(await assertConfigPathsAuthorized(normalizedConfig, currentConfig))) return false
  return await saveConfig(normalizedConfig)
})
