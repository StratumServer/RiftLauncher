import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { FiLoader } from "react-icons/fi"
import { PiCaretDownDuotone, PiMagnifyingGlassDuotone } from "react-icons/pi"
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "@headlessui/react"
import { AnimatePresence, motion } from "motion/react"
import clsx from "clsx"

import { CUSTOM_BACKGROUND_ID, DEFAULT_BACKGROUND_ID } from "@domain/backgrounds"
import { resolveAllowPrerelease } from "@domain/appUpdate/betaUpdates"

import { DROPDOWN_MENU_ITEM_VARIANTS, DROPDOWN_MENU_WRAPPER_VARIANTS } from "@renderer/utils/animateVariants"
import { backgroundImageSource } from "@renderer/utils/backgroundStyle"
import { backgroundThumbnailSource } from "@renderer/utils/backgroundThumbnail"
import { MENU_OPTION_STYLES, MENU_TRIGGER_STYLES } from "@renderer/components/ui/buttonStyles"

import { useSettingsConfig, useConfigDispatch, CONFIG_ACTIONS } from "@renderer/features/config/contexts/ConfigContext"

import defaultBackground from "@renderer/assets/background.jpg"

import {
  FormBody,
  FormFieldDescription,
  FormFieldGroup,
  FormFieldGroupWithDescription,
  FormHead,
  FormLabel,
  FromGroup,
  FromWrapper,
  FormGroupWrapper,
  FormButton,
  FormInputText,
  FormToggle
} from "@renderer/components/ui/FormComponents"
import { NormalButton } from "@renderer/components/ui/Buttons"
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

            <FromGroup>
              <FormHead>
                <FormLabel content={t("features.config.receiveBetaUpdates")} />
              </FormHead>

              <FormBody>
                <BetaUpdatesToggle />
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
                  <FormButton onClick={pickInstallationsFolder} title={t("generic.browse")} variant="secondary" className="px-2 py-1">
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
                  <FormButton onClick={pickVersionsFolder} title={t("generic.browse")} variant="secondary" className="px-2 py-1">
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
                  <FormButton onClick={pickBackupsFolder} title={t("generic.browse")} variant="secondary" className="px-2 py-1">
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
 * Whether update checks offer beta builds.
 *
 * Shows the state that is actually in force rather than the stored one, which is why it needs the
 * running version: with nothing stored, a beta build is already being offered betas and a stable
 * build is not, and a toggle that read `off` on a beta would be lying about what happens next.
 * Touching it stores a real answer, so switching it off while running a beta is what stops the next
 * ones being offered. It does not roll anything back: this build stays until a release it is
 * allowed to see comes along.
 *
 * The version arrives from the main process a moment after this mounts, and until it does there is
 * nothing to draw for an install nobody has answered for: an empty version reads as stable, so a
 * beta user would be shown `off` and could click an opt-out they never meant. So the state stays
 * unknown until the version lands, and the toggle is disabled for as long as it is. A lookup that
 * never answers leaves it disabled rather than guessing.
 */
function BetaUpdatesToggle(): JSX.Element {
  const { t } = useTranslation()

  const { receiveBetaUpdates } = useSettingsConfig()
  const configDispatch = useConfigDispatch()
  /** null until the lookup answers, and forever if it never does. */
  const [runningVersion, setRunningVersion] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    void window.api.utils.getAppVersion().then(
      (version) => {
        if (!cancelled) setRunningVersion(version)
      },
      () => undefined
    )

    return (): void => {
      cancelled = true
    }
  }, [])

  // A stored answer needs no version and is drawn as soon as it is read. Only "nobody has said"
  // has to wait, because there it is the running build that decides.
  const inForce = runningVersion === null ? receiveBetaUpdates : resolveAllowPrerelease(receiveBetaUpdates, runningVersion)

  return (
    <FormFieldGroupWithDescription>
      <FormToggle
        title={t("features.config.receiveBetaUpdatesDesc")}
        disabled={inForce === null}
        value={inForce ?? false}
        onChange={(value) => configDispatch({ type: CONFIG_ACTIONS.SET_RECEIVE_BETA_UPDATES, payload: value })}
      />
      <FormFieldDescription content={t("features.config.receiveBetaUpdatesDesc")} />
    </FormFieldGroupWithDescription>
  )
}

/**
 * The background section: the bundled scene, whatever the `backgrounds` branch lists today, and
 * the player's own picture.
 *
 * The manifest is fetched by the hook when this mounts, which is when the settings page opens.
 *
 * Full-size scenes are downloaded only when the player picks them. The branch also carries a
 * small preview for each catalog entry, and the picker requests those previews eagerly when this
 * section opens so the grid is useful immediately without adding them to the launcher package.
 */
function BackgroundPicker(): JSX.Element {
  const { t } = useTranslation()

  const { background, backgroundRevision } = useSettingsConfig()
  const { entries, loading, failed, retry } = useBackgroundCatalog()
  const { selectDefault, selectFromCatalog, pickCustom, ensureCached } = useSelectBackground()
  const configDispatch = useConfigDispatch()

  // Repairs a cached file that has gone missing under a still-selected scene, and picks up a scene
  // the branch has replaced since the last launch. A refresh writes new bytes under the same name,
  // so the revision has to move for the running session to read them. The flag drops a refresh
  // that lands after the player picked something else, which would otherwise put the old scene
  // back and save it to the config.
  useEffect(() => {
    const selected = entries.find((entry) => entry.id === background)
    if (!selected) return

    let cancelled = false

    void ensureCached(selected).then((result) => {
      if (cancelled || result !== "refreshed") return
      configDispatch({ type: CONFIG_ACTIONS.SET_BACKGROUND, payload: selected.id })
    })

    return (): void => {
      cancelled = true
    }
  }, [entries, background, ensureCached, configDispatch])

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
            source={backgroundThumbnailSource(entry.thumbnail)}
            loading="eager"
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
 * `alt=""` rather than the scene name: the name is already written under the picture. A failed
 * thumbnail is removed so the tile keeps its dark placeholder instead of drawing a broken-image icon.
 */
function BackgroundTile({
  name,
  selected,
  onClick,
  source,
  loading = "eager"
}: Readonly<{ name: string; selected: boolean; onClick: () => void; source?: string; loading?: "eager" | "lazy" }>): JSX.Element {
  const [imageFailed, setImageFailed] = useState(false)

  useEffect(() => {
    setImageFailed(false)
  }, [source])

  return (
    <NormalButton
      variant="secondary"
      size="lg"
      onClick={onClick}
      ariaPressed={selected}
      title={name}
      className={clsx(
        "relative aspect-video w-full overflow-hidden",
        // Two colours meet at this border and only one of them is unknown. Inside is the player's
        // thumbnail, where --color-vsl can fall to 2.51:1 against a light image; outside is the
        // section panel over the shell, the same fixed stack the accent links sit on, where it
        // reads 4.85:1 whatever image was picked. A boundary that is unmistakable along one of its
        // edges is perceivable (WCAG 1.4.11). The extra width raises no ratio: what it buys is
        // 1.4.1, since the selected state stops being marked by hue alone. See text-contrast.test.ts.
        selected ? "border-2 border-vsl" : "border border-zinc-400/5"
      )}
    >
      {source && !imageFailed && <img src={source} alt="" loading={loading} decoding="async" onError={() => setImageFailed(true)} className="absolute inset-0 w-full h-full object-cover" />}
      <span className="absolute inset-x-0 bottom-0 px-1 py-0.5 text-xs text-center bg-zinc-950/70 overflow-hidden whitespace-nowrap text-ellipsis">{name}</span>
    </NormalButton>
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
    document.documentElement.dataset.uiscale = selectedScale.toString()
    window.localStorage.setItem("uiScale", selectedScale.toString())
  }, [selectedScale])

  return (
    <Listbox value={selectedScale} onChange={setSelectedScale}>
      {({ open }) => (
        <>
          {SCALE_OPTIONS.filter((scale) => scale.key === selectedScale).map((scale) => (
            <ListboxButton key={scale.key} className={MENU_TRIGGER_STYLES}>
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
                      className={clsx(MENU_OPTION_STYLES, "odd:bg-zinc-800/30 even:bg-zinc-950/30")}
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
