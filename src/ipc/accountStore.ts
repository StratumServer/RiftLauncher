import { app, safeStorage } from "electron"
import fse from "fs-extra"
import { join } from "node:path"

import { parseStoredSecrets, type AccountSecrets } from "@domain/account/credentials"
import { writeJsonAtomic } from "@src/ipc/atomicJsonFile"

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
  const contents: EncryptedAccountFile = { version: ACCOUNT_STORE_VERSION, ciphertext: encrypted }

  // write-file-atomic opens the temp file with this mode, so the file rename() lands
  // is already 0600; the explicit chmod is defense in depth against a permissive umask,
  // matching what this store did before.
  await writeJsonAtomic(storePath, contents, { mode: 0o600 })
  await fse.chmod(storePath, 0o600).catch(() => undefined)
  cachedSecrets = secrets
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
