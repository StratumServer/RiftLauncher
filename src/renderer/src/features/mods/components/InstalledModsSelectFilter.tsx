import clsx from "clsx"
import { AnimatePresence, motion } from "motion/react"
import { PiCaretDownDuotone } from "react-icons/pi"
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "@headlessui/react"

import { DROPDOWN_MENU_ITEM_VARIANTS, DROPDOWN_MENU_WRAPPER_VARIANTS } from "@renderer/utils/animateVariants"

/**
 * One single-select dropdown over plain strings, used for the author axis and the game version axis
 * of the Manage Mods filter bar. Both lists are short strings pulled from the installed scan, so a
 * Listbox with every option in view fits where the ModDB browse page needs a typeahead.
 *
 * The page passes the labels in already translated: this component holds no i18n of its own.
 */
function InstalledModsSelectFilter({
  value,
  onChange,
  options,
  label,
  anyLabel,
  size = "w-40 h-8"
}: Readonly<{
  value: string
  onChange: (value: string) => void
  options: string[]
  /** Shown while nothing is picked, and the control's accessible name. */
  label: string
  /** The option that clears this axis, e.g. "Any author". */
  anyLabel: string
  size?: string
}>): JSX.Element {
  return (
    <Listbox value={value} onChange={onChange}>
      {({ open }) => (
        <>
          <ListboxButton
            className={clsx(
              "px-2 flex items-center justify-between gap-2 rounded-sm overflow-hidden border border-zinc-400/5 bg-zinc-950/50 shadow-sm shadow-zinc-950/50 hover:shadow-none cursor-pointer",
              size
            )}
            title={value || label}
          >
            <p className={clsx("overflow-hidden whitespace-nowrap text-ellipsis", !value && "text-zinc-400")}>{value || label}</p>
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
                    - {anyLabel} -
                  </ListboxOption>
                  {options.map((option) => (
                    <ListboxOption
                      key={option}
                      value={option}
                      as={motion.li}
                      variants={DROPDOWN_MENU_ITEM_VARIANTS}
                      className="w-full h-8 px-2 py-1 shrink-0 flex items-center overflow-hidden odd:bg-zinc-800/30 even:bg-zinc-950/30 cursor-pointer whitespace-nowrap text-ellipsis text-sm"
                    >
                      {option}
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

export default InstalledModsSelectFilter
