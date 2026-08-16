import { useState } from "react"
import { useTranslation } from "react-i18next"
import { PiCaretDownDuotone, PiPlusCircleDuotone } from "react-icons/pi"
import clsx from "clsx"
import { AnimatePresence, motion } from "motion/react"
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "@headlessui/react"

import { INSTALLATION_ICONS } from "@renderer/utils/installationIcons"
import { DROPDOWN_MENU_ITEM_VARIANTS, DROPDOWN_MENU_WRAPPER_VARIANTS } from "@renderer/utils/animateVariants"

import { FormBody, FormHead, FormLabel, FromGroup, FormFieldDescription, FormInputText, FormFieldGroupWithDescription } from "@renderer/components/ui/FormComponents"
import { AddCustomIconPupup } from "@renderer/components/ui/AddCustomIconPupup"

export interface NameAndIconPickerProps {
  name: string
  onNameChange: (name: string) => void
  icon: IconType
  onIconChange: (icon: IconType) => void
  customIcons: IconType[]
  /**
   * The icon Listbox button carries different sizing classes on Add (w-40,
   * shrink-0) versus Edit (w-1/3): a pre-existing, purely cosmetic difference
   * between the two pages, kept as-is rather than unified.
   */
  iconButtonClassName: string
}

/** The name field and icon picker shared by AddInstallation and EditInstallation. */
export function NameAndIconPicker({ name, onNameChange, icon, onIconChange, customIcons, iconButtonClassName }: NameAndIconPickerProps): JSX.Element {
  const { t } = useTranslation()
  const [addIcon, setAddIcon] = useState<boolean>(false)

  return (
    <FromGroup>
      <FormHead>
        <FormLabel content={t("features.installations.name")} />
      </FormHead>

      <FormBody>
        <FormFieldGroupWithDescription>
          <FormInputText value={name} onChange={(e) => onNameChange(e.target.value)} placeholder={t("features.installations.defaultName")} minLength={5} maxLength={50} />
          <FormFieldDescription content={t("generic.minMaxLength", { min: 5, max: 50 })} />
        </FormFieldGroupWithDescription>
      </FormBody>

      <Listbox value={icon} onChange={(selectedIcon: IconType) => onIconChange(selectedIcon)}>
        {({ open }) => (
          <>
            <ListboxButton className={iconButtonClassName}>
              <div className="w-full h-full flex items-center gap-1">
                <img src={icon.custom ? `icons:${icon.icon}` : icon.icon} alt={t("generic.icon")} className="h-full aspect-square object-cover rounded-sm" />
                <p>{icon.name}</p>
              </div>
              <PiCaretDownDuotone className={clsx("duration-200 shrink-0", open && "rotate-180")} />
            </ListboxButton>

            <AnimatePresence>
              {open && (
                <ListboxOptions static anchor="bottom" className="w-[var(--button-width)] z-600 translate-y-1 select-none rounded-sm overflow-hidden">
                  <motion.ul
                    variants={DROPDOWN_MENU_WRAPPER_VARIANTS}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    className="max-h-80 flex flex-col bg-zinc-950/50 backdrop-blur-md border border-zinc-400/5 shadow-sm shadow-zinc-950/50 hover:shadow-none rounded-sm overflow-y-scroll text-sm"
                  >
                    <ListboxOption
                      onClick={(e) => {
                        e.stopPropagation()
                        setAddIcon(true)
                      }}
                      value={icon}
                      as={motion.li}
                      variants={DROPDOWN_MENU_ITEM_VARIANTS}
                      className="w-full h-13 p-1 shrink-0 flex items-center gap-1 overflow-hidden odd:bg-zinc-800/30 even:bg-zinc-950/30 cursor-pointer text-start"
                    >
                      <div className="w-full h-full flex items-center gap-2">
                        <span className="h-full aspect-square flex items-center justify-center">
                          <PiPlusCircleDuotone className="text-3xl text-zinc-400/25 group-hover:scale-95 duration-200" />
                        </span>
                        <p>{t("generic.addIcon")}</p>
                      </div>
                    </ListboxOption>
                    {customIcons.map((current) => (
                      <ListboxOption
                        key={current.id}
                        value={current}
                        as={motion.li}
                        variants={DROPDOWN_MENU_ITEM_VARIANTS}
                        className="w-full h-13 p-1 shrink-0 flex items-center gap-1 overflow-hidden odd:bg-zinc-800/30 even:bg-zinc-950/30 cursor-pointer text-start"
                      >
                        <div className="w-full h-full flex items-center gap-2">
                          <img src={`icons:${current.icon}`} alt={t("generic.icon")} className="h-full aspect-square object-cover rounded-sm" />
                          <p>{current.name}</p>
                        </div>
                      </ListboxOption>
                    ))}
                    {INSTALLATION_ICONS.map((current) => (
                      <ListboxOption
                        key={current.id}
                        value={current}
                        as={motion.li}
                        variants={DROPDOWN_MENU_ITEM_VARIANTS}
                        className="w-full h-13 p-1 shrink-0 flex items-center gap-1 overflow-hidden odd:bg-zinc-800/30 even:bg-zinc-950/30 cursor-pointer text-start"
                      >
                        <div className="w-full h-full flex items-center gap-2">
                          <img src={current.icon} alt={t("generic.icon")} className="h-full aspect-square object-cover rounded-sm" />
                          <p>{current.name}</p>
                        </div>
                      </ListboxOption>
                    ))}
                  </motion.ul>
                </ListboxOptions>
              )}
            </AnimatePresence>
          </>
        )}
      </Listbox>

      <AddCustomIconPupup open={addIcon} setOpen={setAddIcon} />
    </FromGroup>
  )
}
