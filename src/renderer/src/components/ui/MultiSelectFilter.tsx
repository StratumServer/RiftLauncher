import clsx from "clsx"
import { AnimatePresence, motion } from "motion/react"
import { Dispatch, SetStateAction } from "react"
import { PiCaretDownDuotone, PiCheckFatDuotone } from "react-icons/pi"
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "@headlessui/react"

import { DROPDOWN_MENU_ITEM_VARIANTS, DROPDOWN_MENU_WRAPPER_VARIANTS } from "@renderer/utils/animateVariants"
import { MENU_OPTION_STYLES, MENU_TRIGGER_STYLES } from "@renderer/components/ui/buttonStyles"

interface MultiSelectOption {
  tagid: string | number
  name: string
}

/**
 * One multi-select Listbox over ModDB lookup entries, shared by the filter bar's Tags and Versions
 * axes: same chip-filled trigger, same animated panel with a lookup-failed row, same checkmark on a
 * selected option. `hashPrefix` is the one visual difference between the two: Tags reads as
 * "#category" everywhere it appears, Versions does not, so it stays a flag rather than forcing one
 * look on both. The lookup itself (useTagsLookup / useGameVersionsLookup) stays with each caller.
 */
function MultiSelectFilter<T extends MultiSelectOption>({
  selected,
  onChange,
  options,
  lookupFailed,
  placeholder,
  lookupFailedMessage,
  hashPrefix = false,
  size = "w-full h-8"
}: Readonly<{
  selected: T[]
  onChange: Dispatch<SetStateAction<T[]>>
  options: T[]
  lookupFailed: boolean
  /** Shown in the trigger while nothing is picked, e.g. t("generic.tags"). */
  placeholder: string
  lookupFailedMessage: string
  hashPrefix?: boolean
  size?: string
}>): JSX.Element {
  return (
    <Listbox value={selected} onChange={onChange} multiple>
      {({ open }) => (
        <>
          <ListboxButton className={clsx(MENU_TRIGGER_STYLES, size)} title={selected.map((item) => item.name).join(" · ")}>
            <p className={clsx("flex gap-1 items-center overflow-hidden whitespace-nowrap text-ellipsis overflow-x-scroll scrollbar-none", selected.length < 1 && "text-zinc-400")}>
              {selected.length < 1
                ? placeholder
                : selected.map((item) => (
                    <span className={clsx("relative text-sm px-1 rounded-sm bg-zinc-850/50", hashPrefix && "before:content-['#'] before:relative before:mr-1")} key={item.tagid}>
                      {item.name}
                    </span>
                  ))}
            </p>
            <PiCaretDownDuotone className={clsx("caret-optical shrink-0 duration-200", open && "-rotate-180")} />
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
                  {lookupFailed && <li className="w-full shrink-0 px-2 py-2 text-sm text-red-400">{lookupFailedMessage}</li>}
                  {options.map((option) => (
                    <ListboxOption
                      key={option.tagid}
                      value={option}
                      as={motion.li}
                      variants={DROPDOWN_MENU_ITEM_VARIANTS}
                      className={clsx(
                        MENU_OPTION_STYLES,
                        "odd:bg-zinc-800/30 even:bg-zinc-950/30 whitespace-nowrap text-ellipsis text-sm",
                        hashPrefix && "before:content-['#'] before:relative before:mr-1"
                      )}
                    >
                      <p className="flex items-center gap-1">
                        <span className="whitespace-nowrap overflow-hidden text-ellipsis">{option.name}</span>
                        {selected.includes(option) && <PiCheckFatDuotone className="text-zinc-400" />}
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

export default MultiSelectFilter
