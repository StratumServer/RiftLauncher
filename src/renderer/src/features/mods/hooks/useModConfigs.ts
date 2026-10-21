import { useCallback, useEffect, useState } from "react"

import { fetchModConfigs } from "@renderer/features/moddb/adapters/modsManager"

interface ModConfigsCacheEntry {
  listing: ModConfigsReadResult | undefined
  requestId: number
  listeners: Set<(listing: ModConfigsReadResult | undefined) => void>
}

const entriesByInstallation = new Map<string, ModConfigsCacheEntry>()

function getOrCreateEntry(installationPath: string): ModConfigsCacheEntry {
  let entry = entriesByInstallation.get(installationPath)
  if (!entry) {
    entry = {
      listing: undefined,
      requestId: 0,
      listeners: new Set()
    }
    entriesByInstallation.set(installationPath, entry)
  }
  return entry
}

function startFetch(installationPath: string, entry: ModConfigsCacheEntry): void {
  const requestId = ++entry.requestId
  if (entry.listing !== undefined) {
    entry.listing = undefined
    for (const listener of entry.listeners) listener(undefined)
  }
  void fetchModConfigs(installationPath)
    .then((result) => {
      if (entriesByInstallation.get(installationPath) !== entry || entry.requestId !== requestId) return
      entry.listing = result
      for (const listener of entry.listeners) listener(result)
    })
    .catch(() => {
      // A host that cannot answer is a host that has nothing to include and nothing to warn about.
      if (entriesByInstallation.get(installationPath) !== entry || entry.requestId !== requestId) return
      const fallback: ModConfigsReadResult = { ok: false, reason: "mod-config-unreadable" }
      entry.listing = fallback
      for (const listener of entry.listeners) listener(fallback)
    })
}

/**
 * Reads an Installation's mod configs once per page load, shared across every caller mounted for
 * that Installation, and says when it does not know yet.
 *
 * Every caller on the page (`ManageModsActionBar`, `ExportModConfigsDialog` and
 * `ImportModConfigsDialog`) needs the difference between "the folder is empty" and "the answer has
 * not arrived", and each would get it wrong by treating the second as the first: the export
 * checkbox would offer a choice that includes nothing, and the export and import dialogs would list
 * or tick rows on an Installation whose configs they had not seen. So the answer starts undefined
 * and stays that way until it is one thing or the other.
 *
 * `refresh` is for a caller that has changed the folder or opened a picker after page load: the
 * import dialog asks again per pack and after writing configs, and the export picker asks on open,
 * because the listing they show decides which boxes start ticked and a config that appeared since
 * the page loaded would be missed or called new.
 *
 * @param installationPath The Installation to read, which is the only thing the host will accept.
 * @returns The host's answer, or undefined while it is still being asked, and a way to ask again.
 */
export function useModConfigs(installationPath: string): { listing: ModConfigsReadResult | undefined; refresh: () => void } {
  const [state, setState] = useState<{ path: string; listing: ModConfigsReadResult | undefined }>(() => ({
    path: installationPath,
    listing: entriesByInstallation.get(installationPath)?.listing
  }))

  const refresh = useCallback(() => {
    const entry = getOrCreateEntry(installationPath)
    startFetch(installationPath, entry)
  }, [installationPath])

  useEffect(() => {
    // A component that unmounts mid-answer must not set state, and an Installation change starts a
    // new question rather than adding to the old one. While at least one caller on the page stays
    // mounted for this Installation, they share one in-flight question and one settled answer.
    const entry = getOrCreateEntry(installationPath)

    const listener = (nextListing: ModConfigsReadResult | undefined): void => {
      setState({ path: installationPath, listing: nextListing })
    }
    entry.listeners.add(listener)
    setState((current) => (current.path === installationPath && current.listing === entry.listing ? current : { path: installationPath, listing: entry.listing }))

    if (entry.requestId === 0) {
      startFetch(installationPath, entry)
    }

    return (): void => {
      entry.listeners.delete(listener)
      if (entry.listeners.size === 0 && entriesByInstallation.get(installationPath) === entry) {
        entriesByInstallation.delete(installationPath)
      }
    }
  }, [installationPath])

  const listing = state.path === installationPath ? state.listing : entriesByInstallation.get(installationPath)?.listing
  return { listing, refresh }
}
