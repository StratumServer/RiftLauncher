import { Trans, useTranslation } from "react-i18next"

import { useExternalLinks } from "@renderer/hooks/useExternalLinks"

import { NormalButton } from "@renderer/components/ui/Buttons"

const ISSUES_URL = "https://github.com/StratumServer/RiftLauncher/issues"
const DISCORD_URL = "https://discord.gg/vQm6z2urZs"

/**
 * The heading of one installed-Mods section: what the list is, and where to report it when the
 * launcher got it wrong.
 *
 * The three sections carried the same twenty-line `<Trans>` with the Issues and Discord links
 * spelled out again each time, differing only in which sentence wraps them.
 */
function InstalledModsSectionHeader({ titleKey, descriptionKey, reportKey }: Readonly<{ titleKey: string; descriptionKey: string; reportKey: string }>): JSX.Element {
  const { t } = useTranslation()
  const { openOnBrowser: openExternalLink } = useExternalLinks()

  return (
    <div className="flex flex-col gap-1">
      <h2 className="text-2xl text-center font-bold">{t(titleKey)}</h2>
      <p className="text-zinc-400 text-center">{t(descriptionKey)}</p>
      <p className="text-zinc-400 text-center text-xs italic flex gap-1 items-center justify-center">
        <Trans
          i18nKey={reportKey}
          components={{
            issues: (
              <NormalButton
                title={t("generic.issues")}
                onClick={(e) => {
                  e.stopPropagation()
                  openExternalLink(ISSUES_URL)
                }}
                variant="link"
              >
                {t("generic.issues")}
              </NormalButton>
            ),
            discord: (
              <NormalButton
                title={t("generic.discordContact")}
                onClick={(e) => {
                  e.stopPropagation()
                  openExternalLink(DISCORD_URL)
                }}
                variant="link"
              >
                {t("generic.discordContact")}
              </NormalButton>
            )
          }}
        />
      </p>
    </div>
  )
}

export default InstalledModsSectionHeader
