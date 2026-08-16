import { logMods } from "@renderer/features/moddb/adapters/log"

/** The one preload-bridge touch ListMods needs directly: its own query-skip/query-start log lines. */
export function useLogMods(): typeof logMods {
  return logMods
}
