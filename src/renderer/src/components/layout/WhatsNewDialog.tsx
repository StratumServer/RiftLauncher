import { useState } from "react"
import { useTranslation } from "react-i18next"

import { useSettingsConfig } from "@renderer/features/config/contexts/ConfigContext"
import { useWhatsNew } from "@renderer/features/info/hooks/useWhatsNew"
import { useExternalLinks } from "@renderer/hooks/useExternalLinks"
import { moddbLaunchAction } from "@domain/moddbVisibility"

import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"
import WhatsNewReleaseSection from "@renderer/components/ui/WhatsNewReleaseSection"
import { ButtonsWrapper, FormButton } from "@renderer/components/ui/FormComponents"

const RELEASES_PAGE_URL = "https://github.com/StratumServer/RiftLauncher/releases"

/**
 * "What's new in <version>" after an update (#439), fetched from this repository's GitHub
 * releases rather than the auto-updater's own event: a player who updated through a package
 * manager or a manual download never fires that event, and the notes have to reach them too.
 *
 * Mounted beside ModDbVisibilityPrompt, and gated behind that prompt having nothing to ask for the
 * running version (schemaVersion check included) for the same reason it is gated behind
 * schemaVersion: a launch must never show two full-screen dialogs at once. Closing it, however that happens, marks the running
 * version seen through the config, the same once-only shape the ModDB prompt's answers already
 * take; "All releases" opens the releases page rather than closing anything, so a player can keep
 * reading after leaving. The notes stay readable afterwards on Info & Help, which lists the latest
 * releases on every launch.
 */
function WhatsNewDialog(): JSX.Element {
  const { t } = useTranslation()
  const { schemaVersion, moddbVisibility } = useSettingsConfig()
  const { releases, status, previousVersion, runningVersion, markSeen } = useWhatsNew()
  const { openOnBrowser } = useExternalLinks()
  const [dismissed, setDismissed] = useState(false)

  // Waits for the ModDB prompt the same way it always has, now on that prompt's own decision for
  // the running version rather than on a single lifetime answer: a launch it has a question for is
  // a launch this dialog stays out of.
  const isOpen = schemaVersion !== 0 && moddbLaunchAction(moddbVisibility, runningVersion) !== "prompt" && status === "ready" && releases.length > 0 && !dismissed

  // Every way out of this dialog marks the version seen: "Got it", Escape, a click on the
  // backdrop. Unlike ModDbVisibilityPrompt, which asks a question and must not read a dismissal
  // as an answer, this one only tells the player something, and the notes stay on Info & Help for
  // as long as they want them. Bringing the dialog back on the next launch because they pressed
  // Escape would be nagging, not care.
  const close = (): void => {
    setDismissed(true)
    markSeen()
  }

  const title = releases.length > 1 ? t("components.whatsNew.titleSince", { version: previousVersion }) : t("components.whatsNew.title", { version: releases[0]?.version ?? "" })

  return (
    <PopupDialogPanel title={title} isOpen={isOpen} close={close} scrollBody>
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
          <FormButton onClick={close} title={t("components.whatsNew.gotIt")} variant="secondary" size="md">
            {t("components.whatsNew.gotIt")}
          </FormButton>
        </ButtonsWrapper>
      </>
    </PopupDialogPanel>
  )
}

export default WhatsNewDialog
