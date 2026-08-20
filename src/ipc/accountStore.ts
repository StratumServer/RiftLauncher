import { app, safeStorage } from "electron"
import fse from "fs-extra"
import { join } from "node:path"

import { parseStoredSecrets, type AccountSecrets } from "@src/ipc/accountTypes"

type EncryptedAccountFile = {
  version: 1
  ciphertext: string
}

const ACCOUNT_STORE_VERSION = 1
let cachedSecrets: AccountSecrets | null | undefined

function getAccountStorePath(): string {
  return join(app.getPath("userData"), "account-secrets.json")
}

function assertSecureStorage(): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure account storage is unavailable")
  if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") throw new Error("A system password store is required for account storage")
}

export async function saveAccountSecrets(secrets: AccountSecrets): Promise<void> {
  assertSecureStorage()

  const encrypted = safeStorage.encryptString(JSON.stringify(secrets)).toString("base64")
  const storePath = getAccountStorePath()
  const temporaryPath = `${storePath}.${process.pid}.${Date.now()}.tmp`
  const contents: EncryptedAccountFile = { version: ACCOUNT_STORE_VERSION, ciphertext: encrypted }

  try {
    await fse.writeJSON(temporaryPath, contents, { spaces: 0, mode: 0o600 })
    await fse.chmod(temporaryPath, 0o600).catch(() => undefined)
    await fse.move(temporaryPath, storePath, { overwrite: true })
    await fse.chmod(storePath, 0o600).catch(() => undefined)
    cachedSecrets = secrets
  } finally {
    await fse.remove(temporaryPath).catch(() => undefined)
  }
}

export async function getAccountSecrets(): Promise<AccountSecrets | null> {
  if (cachedSecrets !== undefined) return cachedSecrets

  try {
    assertSecureStorage()
    const stored = (await fse.readJSON(getAccountStorePath(), "utf8")) as Partial<EncryptedAccountFile>
    if (stored.version !== ACCOUNT_STORE_VERSION || typeof stored.ciphertext !== "string") throw new Error("Invalid account store")

    const decrypted = safeStorage.decryptString(Buffer.from(stored.ciphertext, "base64"))
    cachedSecrets = parseStoredSecrets(JSON.parse(decrypted))
  } catch {
    cachedSecrets = null
  }

  return cachedSecrets
}

export async function clearAccountSecrets(): Promise<boolean> {
  try {
    await fse.remove(getAccountStorePath())
    cachedSecrets = null
    return true
  } catch {
    return false
  }
}
