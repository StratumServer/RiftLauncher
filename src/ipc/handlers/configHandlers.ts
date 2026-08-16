import { ipcMain } from "electron"
import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { assertTrustedIpcSender } from "@src/ipc/ipcSecurity"
import { isRecord } from "@src/ipc/validation"
import { assertConfigPathsAuthorized } from "@src/ipc/pathPolicy"
import { invalidPayloadResult, saveOutcomeToResult, unauthorizedPathResult } from "@src/ipc/handlers/saveConfigOutcome"

import { getConfig, normalizeConfig, saveConfig } from "@src/config/configManager"

ipcMain.handle(IPC_CHANNELS.CONFIG_MANAGER.GET_CONFIG, async (event): Promise<ConfigType> => {
  assertTrustedIpcSender(event)
  return await getConfig()
})

ipcMain.handle(IPC_CHANNELS.CONFIG_MANAGER.SAVE_CONFIG, async (event, config: ConfigType): Promise<SaveConfigResult> => {
  assertTrustedIpcSender(event)
  if (!isRecord(config)) return invalidPayloadResult()
  const normalizedConfig = normalizeConfig(config)
  const currentConfig = await getConfig()
  if (!(await assertConfigPathsAuthorized(normalizedConfig, currentConfig))) return unauthorizedPathResult()
  return saveOutcomeToResult(await saveConfig(normalizedConfig))
})
