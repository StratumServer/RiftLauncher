import { ipcMain } from "electron"
import { IPC_CHANNELS } from "@src/ipc/ipcChannels"
import { assertTrustedIpcSender } from "@src/ipc/ipcSecurity"
import { isRecord } from "@src/ipc/validation"
import { assertConfigPathsAuthorized } from "@src/ipc/pathPolicy"
import { invalidPayloadResult, saveOutcomeToResult, sessionReadOnlyResult, unauthorizedPathResult } from "@src/ipc/handlers/saveConfigOutcome"

import { getConfig, isConfigWriteSuppressed, normalizeConfig, saveConfig, takePendingConfigRecoveryNotice } from "@src/config/configManager"

ipcMain.handle(IPC_CHANNELS.CONFIG_MANAGER.GET_CONFIG, async (event): Promise<ConfigType> => {
  assertTrustedIpcSender(event)
  return await getConfig()
})

ipcMain.handle(IPC_CHANNELS.CONFIG_MANAGER.GET_CONFIG_RECOVERY_NOTICE, async (event): Promise<ConfigRecoveryNotice | null> => {
  assertTrustedIpcSender(event)
  // getConfig() is what actually produces the notice (recovery runs on the first real read), and
  // this can be asked before that read has even started: NotificationsProvider mounts alongside
  // ConfigProvider, not after it. Awaiting the same load here (getConfig shares one in-flight
  // promise for every caller once the first read is under way) means the notice always exists by
  // the time it is taken, however early this fires.
  await getConfig()
  return takePendingConfigRecoveryNotice()
})

ipcMain.handle(IPC_CHANNELS.CONFIG_MANAGER.SAVE_CONFIG, async (event, config: ConfigType): Promise<SaveConfigResult> => {
  assertTrustedIpcSender(event)
  if (!isRecord(config)) return invalidPayloadResult()
  const normalizedConfig = normalizeConfig(config)
  const currentConfig = await getConfig()
  if (!(await assertConfigPathsAuthorized(normalizedConfig, currentConfig))) return unauthorizedPathResult()
  const saved = await saveConfig(normalizedConfig)
  if (!saved && isConfigWriteSuppressed()) return sessionReadOnlyResult()
  return saveOutcomeToResult(saved)
})
