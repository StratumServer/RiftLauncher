import { useState } from "react"
import { useTranslation } from "react-i18next"

import { useSettingsConfig } from "@renderer/features/config/contexts/ConfigContext"
import { useWhatsNew } from "@renderer/features/info/hooks/useWhatsNew"
import { useExternalLinks } from "@renderer/hooks/useExternalLinks"
import { MODDB_VISIBILITY_UNASKED } from "@domain/moddbVisibility"

import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"
import WhatsNewReleaseSection from "@renderer/components/ui/WhatsNewReleaseSection"
import { ButtonsWrapper, FormButton } from "@renderer/components/ui/FormComponents"

const RELEASES_PAGE_URL = "https://github.com/StratumServer/RiftLauncher/releases"

/**
 * "What's new in <version>" after an update (#439), fetched from this repository's GitHub
 * releases rather than the auto-updater's own event: a player who updated through a package
 * manager or a manual download never fires that event, and the notes have to reach them too.
 *
 * Mounted beside ModDbVisibilityPrompt, and gated behind that prompt's own answer (schemaVersion
 * check included) for the same reason it is gated behind schemaVersion: a fresh install must never
 * show two full-screen dialogs at once. "Got it" marks the running version seen through the config,
 * the same once-only shape the ModDB prompt's answers already take; "All releases" opens the
 * releases page rather than closing anything, so a player can keep reading after leaving.
 */
function WhatsNewDialog(): JSX.Element {
  const { t } = useTranslation()
  const { schemaVersion, moddbVisibilityAnswer, lastSeenChangelogVersion } = useSettingsConfig()
  const { releases, status, markSeen } = useWhatsNew()
  const { openOnBrowser } = useExternalLinks()
  const [dismissed, setDismissed] = useState(false)

  const isOpen = schemaVersion !== 0 && moddbVisibilityAnswer !== MODDB_VISIBILITY_UNASKED && status === "ready" && releases.length > 0 && !dismissed

  // Escape and a click on the backdrop only dismiss this render: nothing is marked seen, so the
  // dialog is back on the next launch, the same "silence is not consent" rule
  // ModDbVisibilityPrompt already holds its own close to. Only "Got it" records anything.
  const dismissWithoutMarkingSeen = (): void => setDismissed(true)

  const gotIt = (): void => {
    setDismissed(true)
    markSeen()
  }

  const title = releases.length > 1 ? t("components.whatsNew.titleSince", { version: lastSeenChangelogVersion }) : t("components.whatsNew.title", { version: releases[0]?.version ?? "" })

  return (
    <PopupDialogPanel title={title} isOpen={isOpen} close={dismissWithoutMarkingSeen} scrollBody>
      <>
        <div className="flex flex-col gap-4 overflow-y-auto text-zinc-300">
          {releases.map((release) => (
            <WhatsNewReleaseSection key={release.version} release={release} />
          ))}
        </div>

        <ButtonsWrapper className="text-base self-center" bgDark={false} equalWidth flush>
          <FormButton onClick={() => openOnBrowser(RELEASES_PAGE_URL)} title={t("components.whatsNew.allReleases")} variant="secondary" size="md">
            {t("components.whatsNew.allReleases")}
          </FormButton>
          <FormButton onClick={gotIt} title={t("components.whatsNew.gotIt")} variant="secondary" size="md">
            {t("components.whatsNew.gotIt")}
          </FormButton>
        </ButtonsWrapper>
      </>
    </PopupDialogPanel>
  )
}

export default WhatsNewDialog
