import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { FiLoader } from "react-icons/fi"
import { PiCaretDownDuotone, PiMagnifyingGlassDuotone } from "react-icons/pi"
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "@headlessui/react"
import { AnimatePresence, motion } from "motion/react"
import clsx from "clsx"

import { CUSTOM_BACKGROUND_ID, DEFAULT_BACKGROUND_ID } from "@domain/backgrounds"

import { DROPDOWN_MENU_ITEM_VARIANTS, DROPDOWN_MENU_WRAPPER_VARIANTS } from "@renderer/utils/animateVariants"
import { backgroundImageSource } from "@renderer/utils/backgroundStyle"

import { useSettingsConfig, CONFIG_ACTIONS } from "@renderer/features/config/contexts/ConfigContext"

import defaultBackground from "@renderer/assets/background.jpg"

import { FormBody, FormFieldGroup, FormHead, FormLabel, FromGroup, FromWrapper, FormGroupWrapper, FormButton, FormInputText } from "@renderer/components/ui/FormComponents"
import ScrollableContainer from "@renderer/components/ui/ScrollableContainer"
import LanguagesMenu from "@renderer/components/ui/LanguagesMenu"
import { StickyMenuWrapper, StickyMenuGroupWrapper, StickyMenuGroup, StickyMenuBreadcrumbs, GoBackButton, GoToTopButton, ReloadButton } from "@renderer/components/ui/StickyMenu"
import { useConfigFolderPicker } from "@renderer/features/config/hooks/useConfigFolderPicker"
import { useBackgroundCatalog } from "@renderer/features/config/hooks/useBackgroundCatalog"
import { useSelectBackground } from "@renderer/features/config/hooks/useSelectBackground"

function ConfigPage(): JSX.Element {
  const { t } = useTranslation()

  const settings = useSettingsConfig()

  const pickInstallationsFolder = useConfigFolderPicker(CONFIG_ACTIONS.SET_DEFAULT_INSTALLATIONS_FOLDER)
  const pickVersionsFolder = useConfigFolderPicker(CONFIG_ACTIONS.SET_DEFAULT_VERSIONS_FOLDER)
  const pickBackupsFolder = useConfigFolderPicker(CONFIG_ACTIONS.SET_DEFAULT_BACKUPS_FOLDER)

  const scrollRef = useRef<HTMLDivElement | null>(null)

  return (
    <ScrollableContainer ref={scrollRef}>
      <div className="min-h-full flex flex-col items-center justify-center gap-2">
        <StickyMenuWrapper scrollRef={scrollRef}>
          <StickyMenuGroupWrapper>
            <StickyMenuGroup>
              <GoBackButton to="/" />
            </StickyMenuGroup>

            <StickyMenuBreadcrumbs breadcrumbs={[{ name: t("breadcrumbs.config"), to: "/config" }]} />

            <StickyMenuGroup>
              <GoToTopButton scrollRef={scrollRef} />
            </StickyMenuGroup>
          </StickyMenuGroupWrapper>
        </StickyMenuWrapper>

        <FromWrapper className="max-w-[50rem] w-full my-auto">
          <FormGroupWrapper title={t("generic.general")}>
            <FromGroup>
              <FormHead>
                <FormLabel content={t("features.config.language")} />
              </FormHead>

              <FormBody>
                <LanguagesMenu />
              </FormBody>
            </FromGroup>

            <FromGroup>
              <FormHead>
                <FormLabel content={t("features.config.uiScale")} />
              </FormHead>

              <FormBody>
                <UIScale />
              </FormBody>
            </FromGroup>

            <FromGroup>
              <FormHead>
                <FormLabel content={t("features.config.background")} />
              </FormHead>

              <FormBody>
                <BackgroundPicker />
              </FormBody>
            </FromGroup>
          </FormGroupWrapper>

          <FormGroupWrapper title={t("generic.folders")}>
            <FromGroup>
              <FormHead>
                <FormLabel content={t("features.config.defaultInstallationsFolder")} />
              </FormHead>

              <FormBody>
                <FormFieldGroup alignment="x">
                  <FormButton onClick={pickInstallationsFolder} title={t("generic.browse")} className="px-2 py-1">
                    <PiMagnifyingGlassDuotone />
                  </FormButton>
                  <FormInputText value={settings.defaultInstallationsFolder} readOnly className="w-full" />
                </FormFieldGroup>
              </FormBody>
            </FromGroup>

            <FromGroup>
              <FormHead>
                <FormLabel content={t("features.config.defaultVersionsFolder")} />
              </FormHead>

              <FormBody>
                <FormFieldGroup alignment="x">
                  <FormButton onClick={pickVersionsFolder} title={t("generic.browse")} className="px-2 py-1">
                    <PiMagnifyingGlassDuotone />
                  </FormButton>
                  <FormInputText value={settings.defaultVersionsFolder} readOnly className="w-full" />
                </FormFieldGroup>
              </FormBody>
            </FromGroup>

            <FromGroup>
              <FormHead>
                <FormLabel content={t("features.config.backupsFolder")} />
              </FormHead>

              <FormBody>
                <FormFieldGroup alignment="x">
                  <FormButton onClick={pickBackupsFolder} title={t("generic.browse")} className="px-2 py-1">
                    <PiMagnifyingGlassDuotone />
                  </FormButton>
                  <FormInputText value={settings.backupsFolder} readOnly className="w-full" />
                </FormFieldGroup>
              </FormBody>
            </FromGroup>
          </FormGroupWrapper>
        </FromWrapper>
      </div>
    </ScrollableContainer>
  )
}

/**
 * The background section: the bundled scene, whatever the `backgrounds` branch lists today, and
 * the player's own picture.
 *
 * The manifest is fetched by the hook when this mounts, which is when the settings page opens.
 *
 * Known limit: a tile only shows its picture once that scene has been downloaded, which is when the
 * player picks it, so a first visit is a grid of names. That is the price of not pulling seven
 * megabytes down the moment somebody opens their settings. If choosing blind turns out to bother
 * people, the fix is a small thumbnail beside each scene on the branch, not a prefetch.
 */
function BackgroundPicker(): JSX.Element {
  const { t } = useTranslation()

  const { background, backgroundRevision } = useSettingsConfig()
  const { entries, loading, failed, retry } = useBackgroundCatalog()
  const { selectDefault, selectFromCatalog, pickCustom, ensureCached } = useSelectBackground()

  // Repairs a cached file that has gone missing under a still-selected scene. The launcher is
  // showing the bundled default until it lands, which is what the missing file already made it do.
  useEffect(() => {
    const selected = entries.find((entry) => entry.id === background)
    if (selected) void ensureCached(selected)
  }, [entries, background, ensureCached])

  return (
    <div className="w-full flex flex-col gap-2">
      <div className="w-full grid grid-cols-3 gap-2">
        <BackgroundTile name={t("generic.default")} selected={background === DEFAULT_BACKGROUND_ID} onClick={selectDefault} source={defaultBackground} />

        {entries.map((entry) => (
          <BackgroundTile
            key={entry.id}
            name={entry.name}
            selected={background === entry.id}
            onClick={() => void selectFromCatalog(entry)}
            source={backgroundImageSource(entry.id, backgroundRevision)}
          />
        ))}

        <BackgroundTile
          name={t("features.config.ownImage")}
          selected={background === CUSTOM_BACKGROUND_ID}
          onClick={() => void pickCustom()}
          source={background === CUSTOM_BACKGROUND_ID ? backgroundImageSource(CUSTOM_BACKGROUND_ID, backgroundRevision) : undefined}
        />
      </div>

      {loading && !failed && (
        <p className="flex justify-center py-2">
          <FiLoader className="animate-spin text-2xl text-zinc-400" />
        </p>
      )}

      {failed && (
        <div className="flex flex-col items-center justify-center gap-2 py-2">
          <p className="text-sm text-zinc-400">{t("features.config.backgroundsLoadFailed")}</p>
          <ReloadButton onClick={retry} reloading={loading} />
        </div>
      )}
    </div>
  )
}

/**
 * One choice.
 *
 * `alt=""` rather than the scene name: the name is already written under the picture, and an
 * empty alt is also what keeps a tile whose file is not cached from drawing a broken-image icon.
 */
function BackgroundTile({ name, selected, onClick, source }: Readonly<{ name: string; selected: boolean; onClick: () => void; source?: string }>): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={clsx(
        "relative aspect-video w-full rounded-sm overflow-hidden border bg-zinc-950/50 shadow-sm shadow-zinc-950/50 hover:shadow-none cursor-pointer",
        selected ? "border-vsl" : "border-zinc-400/5"
      )}
    >
      {source && <img src={source} alt="" className="absolute inset-0 w-full h-full object-cover" />}
      <span className="absolute inset-x-0 bottom-0 px-1 py-0.5 text-xs text-center bg-zinc-950/70 overflow-hidden whitespace-nowrap text-ellipsis">{name}</span>
    </button>
  )
}

function UIScale(): JSX.Element {
  const { t } = useTranslation()

  const SCALE_OPTIONS = [
    { key: 50, value: "50%" },
    { key: 75, value: "75%" },
    { key: 100, value: "100%" },
    { key: 125, value: "125%" },
    { key: 150, value: "150%" }
  ]

  const [selectedScale, setSelectedScale] = useState<number>(Number(window.localStorage.getItem("uiScale")) || 100)

  useEffect(() => {
    document.documentElement.setAttribute("data-uiscale", selectedScale.toString())
    window.localStorage.setItem("uiScale", selectedScale.toString())
  }, [selectedScale])

  return (
    <Listbox value={selectedScale} onChange={setSelectedScale}>
      {({ open }) => (
        <>
          {SCALE_OPTIONS.filter((scale) => scale.key === selectedScale).map((scale) => (
            <ListboxButton
              key={scale.key}
              className="w-full h-8 px-2 py-1 flex items-center justify-between gap-2 rounded-sm overflow-hidden border border-zinc-400/5 bg-zinc-950/50 shadow-sm shadow-zinc-950/50 hover:shadow-none cursor-pointer"
            >
              <p className="flex gap-2 items-center overflow-hidden whitespace-nowrap">
                <span className="text-sm">{scale.value}</span>
                {scale.key === 100 && <span className="text-ellipsis overflow-hidden text-zinc-400 text-xs">{t("generic.default")}</span>}
              </p>
              <PiCaretDownDuotone className={clsx("shrink-0 duration-200", open && "-rotate-180")} />
            </ListboxButton>
          ))}

          <AnimatePresence>
            {open && (
              <ListboxOptions static anchor="bottom" className="w-[var(--button-width)] z-600 mt-1 select-none rounded-sm overflow-hidden">
                <motion.ul
                  variants={DROPDOWN_MENU_WRAPPER_VARIANTS}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="flex flex-col bg-zinc-950/50 backdrop-blur-md border border-zinc-400/5 shadow-sm shadow-zinc-950/50 hover:shadow-none rounded-sm"
                >
                  {SCALE_OPTIONS.map((scale) => (
                    <ListboxOption
                      key={scale.key}
                      value={scale.key}
                      as={motion.li}
                      variants={DROPDOWN_MENU_ITEM_VARIANTS}
                      className="w-full h-8 px-2 py-1 shrink-0 flex items-center overflow-hidden odd:bg-zinc-800/30 even:bg-zinc-950/30 cursor-pointer"
                    >
                      <p className="flex gap-2 items-center overflow-hidden whitespace-nowrap">
                        <span className="text-sm">{scale.value}</span>
                        {scale.key === 100 && <span className="text-ellipsis overflow-hidden text-zinc-400 text-xs">{t("generic.default")}</span>}
                      </p>
                    </ListboxOption>
                  ))}
                </motion.ul>
              </ListboxOptions>
            )}
          </AnimatePresence>
        </>
      )}
    </Listbox>
  )
}

export default ConfigPage
