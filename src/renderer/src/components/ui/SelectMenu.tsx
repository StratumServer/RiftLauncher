import clsx from "clsx"
import { AnimatePresence, motion } from "motion/react"
import { PiCaretDownDuotone } from "react-icons/pi"
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "@headlessui/react"

import { DROPDOWN_MENU_ITEM_VARIANTS, DROPDOWN_MENU_WRAPPER_VARIANTS } from "@renderer/utils/animateVariants"
import { MENU_OPTION_STYLES, MENU_TRIGGER_STYLES } from "@renderer/components/ui/buttonStyles"

export interface SelectMenuOption<T extends string | number> {
  key: T
  label: string
  /** Muted note beside the label: who translated a locale, which scale is the default. */
  hint?: string
}

/**
 * One single-select Listbox over a fixed set of options, shared by the filter bar's single-value
 * axes (Side, Installed), the language picker and the UI scale picker. The trigger shows the picked
 * option's own label; the panel lists every option with zebra striping. Options are supplied already
 * translated: this component holds no i18n of its own, same as InstalledModsSelectFilter next door.
 *
 * `listSize` is how a caller with more options than fit on screen caps the panel: the languages list
 * scrolls, the four-option filters do not, and a cap in here would put a scrollbar on all of them.
 *
 * The trigger renders whether or not the value matches an option, so a stored value no build offers
 * any more leaves a control the player can still open, and so picking an option does not swap the
 * trigger node out from under the focus Headless UI hands back to it.
 */
function SelectMenu<T extends string | number>({
  value,
  options,
  onChange,
  size = "w-full h-8",
  listSize,
  title
}: Readonly<{
  value: T
  options: SelectMenuOption<T>[]
  onChange: (value: T) => void
  size?: string
  listSize?: string
  /** Tooltip on the trigger, for a row whose own description says what the choice does. */
  title?: string
}>): JSX.Element {
  const selected = options.find((option) => option.key === value)

  return (
    <Listbox value={value} onChange={onChange}>
      {({ open }) => (
        <>
          <ListboxButton className={clsx(MENU_TRIGGER_STYLES, size)} title={title}>
            <OptionLabel option={selected} />
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
                  className={clsx("flex flex-col bg-zinc-950/50 backdrop-blur-md border border-zinc-400/5 shadow-sm shadow-zinc-950/50 hover:shadow-none rounded-sm", listSize)}
                >
                  {options.map((option) => (
                    <ListboxOption
                      key={option.key}
                      value={option.key}
                      as={motion.li}
                      variants={DROPDOWN_MENU_ITEM_VARIANTS}
                      className={clsx(MENU_OPTION_STYLES, "odd:bg-zinc-800/30 even:bg-zinc-950/30")}
                    >
                      <OptionLabel option={option} title={option.label} />
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

/** The trigger shows the same label as the option it stands for, so both read off this. */
function OptionLabel({ option, title }: Readonly<{ option?: { label: string; hint?: string }; title?: string }>): JSX.Element {
  return (
    <p className="flex gap-2 items-center overflow-hidden whitespace-nowrap" title={title}>
      <span className="text-sm">{option?.label}</span>
      {option?.hint !== undefined && <span className="text-ellipsis overflow-hidden text-zinc-400 text-xs">{option.hint}</span>}
    </p>
  )
}

export default SelectMenu
