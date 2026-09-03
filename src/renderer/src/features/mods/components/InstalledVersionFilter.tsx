import clsx from "clsx"
import { AnimatePresence, motion } from "motion/react"
import { Dispatch, SetStateAction } from "react"
import { useTranslation } from "react-i18next"
import { PiCaretDownDuotone } from "react-icons/pi"
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "@headlessui/react"

import { DROPDOWN_MENU_ITEM_VARIANTS, DROPDOWN_MENU_WRAPPER_VARIANTS } from "@renderer/utils/animateVariants"

function InstalledVersionFilter({
  versionFilter,
  setVersionFilter,
  versions,
  size = "w-40 h-8"
}: Readonly<{
  versionFilter: string
  setVersionFilter: Dispatch<SetStateAction<string>>
  versions: string[]
  size?: string
}>): JSX.Element {
  const { t } = useTranslation()

  return (
    <Listbox value={versionFilter} onChange={setVersionFilter}>
      {({ open }) => (
        <>
          <ListboxButton
            className={clsx(
              "px-2 flex items-center justify-between gap-2 rounded-sm overflow-hidden border border-zinc-400/5 bg-zinc-950/50 shadow-sm shadow-zinc-950/50 hover:shadow-none cursor-pointer",
              size
            )}
            title={versionFilter || t("generic.version")}
          >
            <p className={clsx("overflow-hidden whitespace-nowrap text-ellipsis", !versionFilter && "text-zinc-400")}>{versionFilter || t("generic.version")}</p>
            <PiCaretDownDuotone className={clsx("shrink-0 duration-200", open && "-rotate-180")} />
          </ListboxButton>

          <AnimatePresence>
            {open && (
              <ListboxOptions static anchor="bottom" className="w-[var(--button-width)] z-600 mt-1 select-none rounded-sm overflow-hidden">
                <motion.ul
                  variants={DROPDOWN_MENU_WRAPPER_VARIANTS}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="w-full max-h-40 flex flex-col bg-zinc-950/50 backdrop-blur-md border border-zinc-400/5 shadow-sm shadow-zinc-950/50 hover:shadow-none rounded-sm overflow-y-scroll"
                >
                  <ListboxOption
                    value=""
                    as={motion.li}
                    variants={DROPDOWN_MENU_ITEM_VARIANTS}
                    className="w-full h-8 px-2 py-1 shrink-0 flex items-center overflow-hidden odd:bg-zinc-800/30 cursor-pointer whitespace-nowrap text-ellipsis text-sm"
                  >
                    - {t("generic.everyone")} -
                  </ListboxOption>
                  {versions.map((version) => (
                    <ListboxOption
                      key={version}
                      value={version}
                      as={motion.li}
                      variants={DROPDOWN_MENU_ITEM_VARIANTS}
                      className="w-full h-8 px-2 py-1 shrink-0 flex items-center overflow-hidden odd:bg-zinc-800/30 even:bg-zinc-950/30 cursor-pointer whitespace-nowrap text-ellipsis text-sm"
                    >
                      {version}
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

export default InstalledVersionFilter
