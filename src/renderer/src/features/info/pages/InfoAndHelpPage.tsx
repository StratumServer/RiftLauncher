import { useRef } from "react"
import { Trans, useTranslation } from "react-i18next"
import { PiDiscordLogoDuotone, PiCoinsDuotone, PiInfoDuotone, PiCodeDuotone, PiUsersThreeDuotone, PiGithubLogoDuotone } from "react-icons/pi"

import ScrollableContainer from "@renderer/components/ui/ScrollableContainer"
import { FormButton } from "@renderer/components/ui/FormComponents"
import { NormalButton } from "@renderer/components/ui/Buttons"
import DropdownSection from "@renderer/components/ui/DropdownSection"
import { StickyMenuWrapper, StickyMenuGroupWrapper, StickyMenuGroup, StickyMenuBreadcrumbs, GoBackButton, GoToTopButton } from "@renderer/components/ui/StickyMenu"
import { useExternalLinks } from "@renderer/hooks/useExternalLinks"
import { useAppInfo } from "@renderer/features/info/hooks/useAppInfo"

function InfoAndHelpPage(): JSX.Element {
  const { t } = useTranslation()
  const { openOnBrowser } = useExternalLinks()
  const { vslVersion, os, openLogsFolder } = useAppInfo()

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

        <div className="w-[50rem] flex flex-col justify-center gap-6 my-auto">
          <h1 className="text-center text-4xl font-bold">{t("features.infoAndHelp.title")}</h1>

          <div className="w-full shrink-0 flex flex-wrap items-center justify-center gap-2">
            <SocialButtons icon={<PiGithubLogoDuotone />} to="https://github.com/StratumServer/RiftLauncher/issues" text={t("generic.issues")} />
            <SocialButtons icon={<PiInfoDuotone />} to="https://vsldocs.xurxomf.xyz/" text={t("generic.guides")} />
            <SocialButtons icon={<PiDiscordLogoDuotone />} to="https://discord.gg/RtWpYBRRUz" text={t("generic.discordContact")} />
            <SocialButtons icon={<PiCoinsDuotone />} to="https://ko-fi.com/zaldaryon" text={t("generic.donate")} />
            <SocialButtons icon={<PiUsersThreeDuotone />} to="https://github.com/StratumServer/RiftLauncher/blob/main/docs/important-info/contributors.md" text={t("generic.contributors")} />
            <SocialButtons icon={<PiCodeDuotone />} to="https://github.com/StratumServer/RiftLauncher" text={t("generic.source")} />
          </div>

          <DropdownSection title={t("features.infoAndHelp.debugInfoTitle")} startOpen={false}>
            <p>{t("features.infoAndHelp.debugInfoDesc")}</p>

            <div className="select-all p-2 rounded-sm overflow-hidden border border-zinc-400/5 bg-zinc-950/50 enabled:shadow-sm enabled:shadow-zinc-950/50 enabled:hover:shadow-none enabled:cursor-pointer disabled:opacity-50">
              <p>VS Launcher Version - v{vslVersion}</p>
              <p>OS Type - {os}</p>
            </div>

            <p className="flex gap-1 items-center flex-wrap">
              <Trans
                i18nKey="features.infoAndHelp.includeLogs"
                components={{
                  folderlink: (
                    <NormalButton title={t("features.infoAndHelp.logsFolderTitle")} onClick={openLogsFolder} className="text-vsl">
                      {t("features.infoAndHelp.thisFolder")}
                    </NormalButton>
                  )
                }}
              />
            </p>
          </DropdownSection>

          <span className="flex gap-1 items-center flex-wrap justify-center animate-pulse">
            <Trans
              i18nKey="generic.tryMVL"
              components={{
                link: (
                  <NormalButton title="MVL" onClick={() => openOnBrowser("https://mods.vintagestory.at/mvl")} className="text-vsl">
                    MVL
                  </NormalButton>
                )
              }}
            />
          </span>
        </div>
      </div>
    </ScrollableContainer>
  )
}

function SocialButtons({ icon, to, text }: { icon: JSX.Element; to: string; text: string }): JSX.Element {
  const { openOnBrowser } = useExternalLinks()

  return (
    <FormButton
      title={text}
      onClick={() => openOnBrowser(to)}
      className={
        "text-lg backdrop-blur-xs border border-zinc-400/5 bg-zinc-950/50 shadow-sm shadow-zinc-950/50 hover:shadow-none flex items-center justify-center gap-1 rounded-sm cursor-pointer px-1 duration-200"
      }
    >
      {icon}
      <span>{text}</span>
    </FormButton>
  )
}

export default InfoAndHelpPage
