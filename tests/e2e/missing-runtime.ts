/**
 * The two decisions of the packaged Windows conformance run's missing-runtime
 * phase that need nothing from Windows, kept here for the reason
 * launcher-death.ts gives: packaged-windows-install.ts exits on import anywhere
 * but a Windows CI runner, which leaves a test nothing to reach.
 */

import { isRecord } from "../../src/ipc/validation"

/**
 * A framework version no .NET release has reached, so no runtime a machine can
 * have installed satisfies it, whatever the roll-forward policy of the build.
 */
export const UNAVAILABLE_FRAMEWORK_VERSION = "99.0.0"

export type FrameworkChange = { name: string | null; from: string | null }

/**
 * Rewrites a `*.runtimeconfig.json` so every framework it asks for wants
 * {@link UNAVAILABLE_FRAMEWORK_VERSION}, and says which ones it changed.
 *
 * Both spellings are covered because the game's file carries both
 * (`runtimeOptions.framework` and the entries of `runtimeOptions.frameworks`,
 * Microsoft.NETCore.App and Microsoft.WindowsDesktop.App), and the host
 * resolves each of them: leaving one behind would let a machine that has that
 * runtime start the game instead of reporting the missing one. The rest of the
 * document is kept as it was. A file with no framework entry at all is an
 * error, not a no-op, since the run would then prove nothing.
 */
export function askForUnavailableRuntime(text: string): { text: string; changes: FrameworkChange[] } {
  // Some tools write a byte order mark, which JSON.parse refuses.
  const document: unknown = JSON.parse(text.replace(/^﻿/, ""))
  if (!isRecord(document) || !isRecord(document.runtimeOptions)) throw new Error("The runtimeconfig.json has no runtimeOptions object")

  const { runtimeOptions } = document
  const entries = [runtimeOptions.framework, ...(Array.isArray(runtimeOptions.frameworks) ? runtimeOptions.frameworks : [])].filter(isRecord)
  if (entries.length === 0) throw new Error("The runtimeconfig.json names no framework to change")

  const changes = entries.map((entry): FrameworkChange => {
    const change = { name: typeof entry.name === "string" ? entry.name : null, from: typeof entry.version === "string" ? entry.version : null }
    entry.version = UNAVAILABLE_FRAMEWORK_VERSION
    return change
  })

  return { text: `${JSON.stringify(document, null, 2)}\n`, changes }
}

/**
 * Whether EXECUTE_GAME's answer is exactly a missing .NET runtime and nothing
 * else: `ok: false` and `reason: "missing-dotnet"`, with `settingsSetAside` the
 * only extra key the type defines, and only when it carries no value (the wire
 * drops an undefined one, so it is normally absent).
 */
export function isMissingDotnetResult(value: unknown): boolean {
  if (!isRecord(value) || value.ok !== false || value.reason !== "missing-dotnet") return false
  return Object.entries(value).every(([key, entry]) => key === "ok" || key === "reason" || (key === "settingsSetAside" && entry === undefined))
}
