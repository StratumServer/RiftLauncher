import clsx from "clsx"
import { AnimatePresence, motion } from "motion/react"
import { Dispatch, SetStateAction } from "react"
import { PiCaretDownDuotone } from "react-icons/pi"
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "@headlessui/react"

import { DROPDOWN_MENU_ITEM_VARIANTS, DROPDOWN_MENU_WRAPPER_VARIANTS } from "@renderer/utils/animateVariants"
import { MENU_OPTION_STYLES, MENU_TRIGGER_STYLES } from "@renderer/components/ui/buttonStyles"

export interface SelectMenuOption<T extends string> {
  key: T
  label: string
}

/**
 * One single-select Listbox over a fixed set of string options, shared by the filter bar's
 * single-value axes (Side, Installed). The trigger shows the picked option's own label; the panel
 * lists every option with zebra striping. Options are supplied already translated: this component
 * holds no i18n of its own, same as InstalledModsSelectFilter next door.
 */
function SelectMenu<T extends string>({
  value,
  options,
  onChange,
  size = "w-full h-8"
}: Readonly<{
  value: T
  options: SelectMenuOption<T>[]
  onChange: Dispatch<SetStateAction<T>>
  size?: string
}>): JSX.Element {
  return (
    <Listbox value={value} onChange={onChange}>
      {({ open }) => (
        <>
          {options
            .filter((option) => option.key === value)
            .map((selected) => (
              <ListboxButton key={selected.key} className={clsx(MENU_TRIGGER_STYLES, size)}>
                <p className="flex gap-2 items-center overflow-hidden whitespace-nowrap text-sm">{selected.label}</p>
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
                  {options.map((option) => (
                    <ListboxOption
                      key={option.key}
                      value={option.key}
                      as={motion.li}
                      variants={DROPDOWN_MENU_ITEM_VARIANTS}
                      className={clsx(MENU_OPTION_STYLES, "odd:bg-zinc-800/30 even:bg-zinc-950/30")}
                    >
                      <p className="flex gap-2 items-center overflow-hidden whitespace-nowrap text-sm" title={option.label}>
                        {option.label}
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

export default SelectMenu
