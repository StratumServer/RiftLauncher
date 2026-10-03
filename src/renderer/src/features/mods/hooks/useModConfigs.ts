import { useCallback, useEffect, useState } from "react"

import { fetchModConfigs } from "@renderer/features/moddb/adapters/modsManager"

/**
 * Reads an Installation's mod configs once, and says when it does not know yet.
 *
 * Both callers need the difference between "the folder is empty" and "the answer has not arrived",
 * and both would get it wrong by treating the second as the first: the export checkbox would offer
 * a choice that includes nothing, and the import dialog would tick every row on an installation
 * whose configs it had not seen. So the answer starts undefined and stays that way until it is one
 * thing or the other.
 *
 * `refresh` is for a caller that has changed the folder and knows it: the import dialog asks again
 * per pack, because the listing it shows decides which boxes start ticked and a config that appeared
 * since the page loaded would be called new.
 *
 * @param installationPath The Installation to read, which is the only thing the host will accept.
 * @returns The host's answer, or undefined while it is still being asked, and a way to ask again.
 */
export function useModConfigs(installationPath: string): { listing: ModConfigsReadResult | undefined; refresh: () => void } {
  const [listing, setListing] = useState<ModConfigsReadResult | undefined>(undefined)
  const [askedAt, setAskedAt] = useState(0)

  const refresh = useCallback(() => {
    setAskedAt((count) => count + 1)
  }, [])

  useEffect(() => {
    // A component that unmounts mid-answer must not set state, and an Installation change starts a
    // new question rather than adding to the old one.
    let live = true
    setListing(undefined)
    void fetchModConfigs(installationPath)
      .then((result) => {
        if (live) setListing(result)
      })
      .catch(() => {
        // A host that cannot answer is a host that has nothing to include and nothing to warn about.
        if (live) setListing({ ok: false, reason: "mod-config-unreadable" })
      })

    return (): void => {
      live = false
    }
  }, [installationPath, askedAt])

  return { listing, refresh }
}
