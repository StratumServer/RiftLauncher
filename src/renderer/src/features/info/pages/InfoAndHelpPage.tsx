import { useRef } from "react"
import { Trans, useTranslation } from "react-i18next"
import { PiDiscordLogoDuotone, PiInfoDuotone, PiCodeDuotone, PiUsersThreeDuotone, PiGithubLogoDuotone, PiShieldCheckDuotone } from "react-icons/pi"

import ScrollableContainer from "@renderer/components/ui/ScrollableContainer"
import { FormButton } from "@renderer/components/ui/FormComponents"
import { NormalButton } from "@renderer/components/ui/Buttons"
import DropdownSection from "@renderer/components/ui/DropdownSection"
import WhatsNewReleaseSection from "@renderer/components/ui/WhatsNewReleaseSection"
import { StickyMenuWrapper, StickyMenuGroupWrapper, StickyMenuGroup, StickyMenuBreadcrumbs, GoBackButton, GoToTopButton } from "@renderer/components/ui/StickyMenu"
import { useExternalLinks } from "@renderer/hooks/useExternalLinks"
import { useAppInfo } from "@renderer/features/info/hooks/useAppInfo"
import { useLatestReleases } from "@renderer/features/info/hooks/useWhatsNew"

const RELEASES_PAGE_URL = "https://github.com/StratumServer/RiftLauncher/releases"

function InfoAndHelpPage(): JSX.Element {
  const { t } = useTranslation()
  const { vslVersion, os, openLogsFolder } = useAppInfo()
  // The latest releases, not the ones this update brought: the section is here to be read on any
  // launch, so it never depends on whether the startup dialog has already been dismissed.
  const { releases, status } = useLatestReleases(vslVersion)
  const { openOnBrowser } = useExternalLinks()

  const scrollRef = useRef<HTMLDivElement | null>(null)

  return (
    <ScrollableContainer ref={scrollRef}>
      <div className="min-h-full flex flex-col items-center justify-center gap-2">
        <StickyMenuWrapper scrollRef={scrollRef}>
          <StickyMenuGroupWrapper>
            <StickyMenuGroup>
              <GoBackButton to="/" />
            </StickyMenuGroup>

            <StickyMenuBreadcrumbs breadcrumbs={[{ name: t("breadcrumbs.infoAndHelp"), to: "/info-and-help" }]} />

            <StickyMenuGroup>
              <GoToTopButton scrollRef={scrollRef} />
            </StickyMenuGroup>
          </StickyMenuGroupWrapper>
        </StickyMenuWrapper>

        {/* max-w, not a fixed width: the scroll container is 730px at 1024x600, and a fixed 50rem
            block centred inside it overruns on both sides, clipping the title, the Privacy Policy
            button and "All releases" with no way to scroll to them. Same shape as every other page. */}
        <div className="max-w-[50rem] w-full flex flex-col justify-center gap-6 my-auto">
          <h1 className="text-center text-4xl font-bold">{t("features.infoAndHelp.title")}</h1>

          <div className="w-full shrink-0 flex flex-wrap items-center justify-center gap-2">
            <SocialButtons icon={<PiGithubLogoDuotone />} to="https://github.com/StratumServer/RiftLauncher/issues" text={t("generic.issues")} />
            <SocialButtons icon={<PiInfoDuotone />} to="https://github.com/StratumServer/RiftLauncher/wiki" text={t("generic.guides")} />
            <SocialButtons icon={<PiDiscordLogoDuotone />} to="https://discord.gg/vQm6z2urZs" text={t("generic.discordContact")} />
            <SocialButtons icon={<PiUsersThreeDuotone />} to="https://github.com/StratumServer/RiftLauncher/blob/main/docs/important-info/contributors.md" text={t("generic.contributors")} />
            <SocialButtons icon={<PiShieldCheckDuotone />} to="https://github.com/StratumServer/RiftLauncher/blob/main/PRIVACY.md" text={t("generic.privacyPolicy")} />
            <SocialButtons icon={<PiCodeDuotone />} to="https://github.com/StratumServer/RiftLauncher" text={t("generic.source")} />
          </div>

          <DropdownSection title={t("features.infoAndHelp.whatsNewTitle")} startOpen={false}>
            {status === "unavailable" ? <p>{t("features.infoAndHelp.whatsNewUnavailable")}</p> : releases.map((release) => <WhatsNewReleaseSection key={release.version} release={release} />)}

            <FormButton onClick={() => openOnBrowser(RELEASES_PAGE_URL)} title={t("components.whatsNew.allReleases")} variant="secondary" size="md" className="self-start">
              {t("components.whatsNew.allReleases")}
            </FormButton>
          </DropdownSection>

          <DropdownSection title={t("features.infoAndHelp.debugInfoTitle")} startOpen={false}>
            <p>{t("features.infoAndHelp.debugInfoDesc")}</p>

            <div className="select-all p-2 rounded-sm overflow-hidden border border-zinc-400/5 bg-zinc-950/50 enabled:shadow-sm enabled:shadow-zinc-950/50 enabled:hover:shadow-none enabled:cursor-pointer disabled:opacity-50">
              <p>RiftLauncher Version - v{vslVersion}</p>
              <p>OS Type - {os}</p>
            </div>

            <p className="flex gap-1 items-center flex-wrap">
              <Trans
                i18nKey="features.infoAndHelp.includeLogs"
                components={{
                  folderlink: (
                    <NormalButton title={t("features.infoAndHelp.logsFolderTitle")} onClick={openLogsFolder} variant="link">
                      {t("features.infoAndHelp.thisFolder")}
                    </NormalButton>
                  )
                }}
              />
            </p>
          </DropdownSection>
        </div>
      </div>
    </ScrollableContainer>
  )
}

function SocialButtons({ icon, to, text }: Readonly<{ icon: JSX.Element; to: string; text: string }>): JSX.Element {
  const { openOnBrowser } = useExternalLinks()

  return (
    <FormButton title={text} onClick={() => openOnBrowser(to)} variant="secondary" size="md" className="text-lg px-1">
      {icon}
      <span>{text}</span>
    </FormButton>
  )
}

export default InfoAndHelpPage
