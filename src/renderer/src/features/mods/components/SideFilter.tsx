import clsx from "clsx"
import { AnimatePresence, motion } from "motion/react"
import { Dispatch, SetStateAction } from "react"
import { useTranslation } from "react-i18next"
import { PiCaretDownDuotone } from "react-icons/pi"
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "@headlessui/react"

import { DROPDOWN_MENU_ITEM_VARIANTS, DROPDOWN_MENU_WRAPPER_VARIANTS } from "@renderer/utils/animateVariants"
import { MENU_OPTION_STYLES, MENU_TRIGGER_STYLES } from "@renderer/components/ui/buttonStyles"

function SideFilter({ sideFilter, setSideFilter, size = "w-full h-8" }: Readonly<{ sideFilter: string; setSideFilter: Dispatch<SetStateAction<string>>; size?: string }>): JSX.Element {
  const { t } = useTranslation()

  const SIDE_FILTERS = [
    { key: "any", value: t("generic.any") },
    { key: "both", value: t("generic.both") },
    { key: "server", value: t("generic.server") },
    { key: "client", value: t("generic.client") }
  ]

  return (
    <Listbox value={sideFilter} onChange={setSideFilter}>
      {({ open }) => (
        <>
          {SIDE_FILTERS.filter((side) => side.key === sideFilter).map((lang) => (
            <ListboxButton key={lang.key} className={clsx(MENU_TRIGGER_STYLES, size)}>
              <p className="flex gap-2 items-center overflow-hidden whitespace-nowrap text-sm">{lang.value}</p>
              <PiCaretDownDuotone className={clsx("caret-optical shrink-0 duration-200", open && "-rotate-180")} />
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
                  {SIDE_FILTERS.map((side) => (
                    <ListboxOption key={side.key} value={side.key} as={motion.li} variants={DROPDOWN_MENU_ITEM_VARIANTS} className={clsx(MENU_OPTION_STYLES, "odd:bg-zinc-800/30 even:bg-zinc-950/30")}>
                      <p className="flex gap-2 items-center overflow-hidden whitespace-nowrap text-sm" title={side.value}>
                        {side.value}
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

export default SideFilter
