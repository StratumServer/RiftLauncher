import { useTranslation } from "react-i18next"
import { AnimatePresence, motion } from "motion/react"
import { Menu, MenuButton, MenuItem, MenuItems } from "@headlessui/react"
import clsx from "clsx"
import { PiArrowClockwiseDuotone, PiFolderOpenDuotone, PiBoxArrowUpDuotone, PiBoxArrowDownDuotone, PiDesktopTowerDuotone, PiStackDuotone, PiPackageDuotone } from "react-icons/pi"

import { useExportModpack } from "@renderer/features/mods/hooks/useExportModpack"
import { resolveModsFolder } from "@renderer/features/mods/adapters/folder"
import { useOpenPathInExplorer } from "@renderer/features/installations/hooks/usePathActions"

import { FormButton } from "@renderer/components/ui/FormComponents"
import { StickyMenuGroupWrapper, StickyMenuGroup } from "@renderer/components/ui/StickyMenu"
import { BUTTON_BASE_STYLES, BUTTON_SIZE_STYLES, BUTTON_VARIANT_STYLES, MENU_OPTION_STYLES } from "@renderer/components/ui/buttonStyles"
import { DROPDOWN_MENU_ITEM_VARIANTS, DROPDOWN_MENU_WRAPPER_VARIANTS } from "@renderer/utils/animateVariants"

/** A Mod the game loads on a server: everything that does not declare itself client-only. */
function isServerMod(side: string | undefined): boolean {
  if (!side) return true
  return !side.toLowerCase().startsWith("client")
}

/** Everything the Mods page does to the whole folder at once: update, export, import, open it. */
function ManageModsActionBar({
  installation,
  installedMods,
  onUpdateAll,
  onImportModpack,
  activeProfileName,
  onOpenProfiles,
  busy = false
}: Readonly<{
  installation: InstallationType
  installedMods: InstalledModType[]
  onUpdateAll: () => void
  onImportModpack: () => void
  /** The profile the Mods folder is in, or undefined when none is active. */
  activeProfileName: string | undefined
  onOpenProfiles: () => void
  /** A batch or a profile switch is renaming archives. Update all, an import or a switch would race it on the same files. */
  busy?: boolean
}>): JSX.Element {
  const { t } = useTranslation()

  const exportModpack = useExportModpack()
  const openPathInExplorer = useOpenPathInExplorer()

  // A modpack is the set someone else is meant to be able to play, so a Mod the player turned off
  // is not in it. Both exports read this list, and both are greyed out by it: a folder whose Mods
  // are all disabled has nothing to export, and saying so beats writing an empty manifest.
  const enabledMods = installedMods.filter((iMod) => iMod.enabled)

  // The server export ships this list and is greyed out by this list. Deriving it twice is how a
  // search that leaves only client Mods once produced a live button and a `{ mods: [] }` manifest.
  const serverMods = enabledMods.filter((iMod) => isServerMod(iMod.side))

  return (
    <StickyMenuGroupWrapper type="centered">
      <StickyMenuGroup>
        <FormButton title={t("features.mods.updateAll")} variant="primary" className="p-1 w-fit h-8" onClick={onUpdateAll} disabled={busy}>
          <PiArrowClockwiseDuotone className="text-xl" />
          <p>{t("features.mods.updateAllButton")}</p>
        </FormButton>

        {/* Next to Update all rather than at the end: the right end of this bar sits under the toasts at 1280 wide. */}
        <FormButton
          title={
            activeProfileName === undefined
              ? t("features.mods.profilesButtonTitle")
              : t("features.mods.profilesButtonTitleActive", { profile: activeProfileName, interpolation: { escapeValue: false } })
          }
          variant="secondary"
          className="p-1 w-fit h-8"
          onClick={onOpenProfiles}
          disabled={busy}
        >
          <PiStackDuotone className="text-xl" />
          <p className="max-w-40 truncate">{activeProfileName ?? t("features.mods.noProfile")}</p>
        </FormButton>

        {/*
         * Import, Export and Export for a server used to be three buttons here on their own: rarely
         * used, and the longest labels on the bar. One menu keeps them one Tab stop away instead of
         * three, without dropping any of them. The trigger keeps the same secondary look they had.
         */}
        <Menu>
          {({ open }) => (
            <>
              <MenuButton title={t("features.mods.modpackMenu")} className={clsx(BUTTON_BASE_STYLES, BUTTON_SIZE_STYLES.sm, "overflow-hidden", BUTTON_VARIANT_STYLES.secondary, "p-1 w-fit h-8")}>
                <span aria-hidden="true" className="flex shrink-0 items-center">
                  <PiPackageDuotone className="text-xl" />
                </span>
                <span>{t("features.mods.modpackMenuButton")}</span>
              </MenuButton>

              <AnimatePresence>
                {open && (
                  // modal=false: this is a small action menu, not a dialog. The default would mark
                  // the rest of the page (the Mod list, its checkboxes, the other bar controls)
                  // inert to assistive tech for as long as it stayed open, which a menu this size
                  // never earns.
                  <MenuItems static anchor="bottom start" modal={false} className="w-64 z-600 mt-1 select-none rounded-sm overflow-hidden">
                    <motion.ul
                      variants={DROPDOWN_MENU_WRAPPER_VARIANTS}
                      initial="initial"
                      animate="animate"
                      exit="exit"
                      className="w-full flex flex-col bg-zinc-950/50 backdrop-blur-md border border-zinc-400/5 shadow-sm shadow-zinc-950/50 hover:shadow-none rounded-sm"
                    >
                      <MenuItem as={motion.li} variants={DROPDOWN_MENU_ITEM_VARIANTS} className={clsx(MENU_OPTION_STYLES, "odd:bg-zinc-800/30 even:bg-zinc-950/30")}>
                        <FormButton
                          title={t("features.mods.exportModpack")}
                          variant="ghost"
                          className="w-full"
                          onClick={() => exportModpack({ installedMods: enabledMods, installation })}
                          disabled={enabledMods.length === 0}
                        >
                          <div className="w-full flex items-center gap-2">
                            <PiBoxArrowUpDuotone className="text-xl shrink-0" />
                            <p className="truncate">{t("features.mods.exportModpackButton")}</p>
                          </div>
                        </FormButton>
                      </MenuItem>

                      <MenuItem as={motion.li} variants={DROPDOWN_MENU_ITEM_VARIANTS} className={clsx(MENU_OPTION_STYLES, "odd:bg-zinc-800/30 even:bg-zinc-950/30")}>
                        <FormButton
                          title={t("features.mods.exportServerModpack")}
                          variant="ghost"
                          className="w-full"
                          onClick={() => exportModpack({ installedMods: serverMods, installation: { ...installation, name: `${installation.name} (Server)` } })}
                          disabled={serverMods.length === 0}
                        >
                          <div className="w-full flex items-center gap-2">
                            <PiDesktopTowerDuotone className="text-xl shrink-0" />
                            <p className="truncate">{t("features.mods.exportServerModpackButton")}</p>
                          </div>
                        </FormButton>
                      </MenuItem>

                      <MenuItem as={motion.li} variants={DROPDOWN_MENU_ITEM_VARIANTS} className={clsx(MENU_OPTION_STYLES, "odd:bg-zinc-800/30 even:bg-zinc-950/30")}>
                        <FormButton title={t("features.mods.importModpack")} variant="ghost" className="w-full" onClick={onImportModpack} disabled={busy}>
                          <div className="w-full flex items-center gap-2">
                            <PiBoxArrowDownDuotone className="text-xl shrink-0" />
                            <p className="truncate">{t("features.mods.importModpackButton")}</p>
                          </div>
                        </FormButton>
                      </MenuItem>
                    </motion.ul>
                  </MenuItems>
                )}
              </AnimatePresence>
            </>
          )}
        </Menu>

        <FormButton
          title={t("features.mods.openModsFolder")}
          variant="ghost"
          className="w-8 h-8"
          onClick={async () => {
            const path = await resolveModsFolder(installation.path)
            openPathInExplorer(path, { ensure: true })
          }}
        >
          <PiFolderOpenDuotone className="text-xl" />
        </FormButton>
      </StickyMenuGroup>
    </StickyMenuGroupWrapper>
  )
}

export default ManageModsActionBar
