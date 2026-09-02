import { useState } from "react"
import { useTranslation } from "react-i18next"
import { PiCaretDownDuotone } from "react-icons/pi"
import { AnimatePresence, motion } from "motion/react"
import clsx from "clsx"

import { Listbox, ListboxButton, ListboxOptions, ListboxOption } from "@headlessui/react"

import { DROPDOWN_MENU_ITEM_VARIANTS, DROPDOWN_MENU_WRAPPER_VARIANTS } from "@renderer/utils/animateVariants"
import { useChangeLanguage } from "@renderer/features/config/hooks/useChangeLanguage"
import { MENU_OPTION_STYLES, MENU_TRIGGER_STYLES } from "@renderer/components/ui/buttonStyles"

function LanguagesMenu(): JSX.Element {
  const { i18n, t } = useTranslation()
  const applyLanguageChange = useChangeLanguage()
  const [selectedLanguage, setSelectedLanguage] = useState<string>(window.localStorage.getItem("lang") || "en-US")

  const getLanguages = (): { code: string; name: string; credits: string }[] => {
    const resources = i18n.options.resources
    if (!resources) return []
    return Object.keys(resources).map((code) => ({
      code,
      name: typeof resources[code]?.name === "string" ? resources[code].name : code,
      credits: typeof resources[code]?.credits === "string" ? resources[code].credits : t("generic.byAnonymous")
    }))
  }

  const languages = getLanguages()

  const handleLanguageChange = async (lang: string): Promise<void> => {
    if (!(await applyLanguageChange(lang))) return
    localStorage.setItem("lang", lang)
    setSelectedLanguage(lang)
  }

  return (
    <Listbox value={selectedLanguage} onChange={handleLanguageChange}>
      {({ open }) => (
        <>
          {languages
            .filter((lang) => lang.code === selectedLanguage)
            .map((lang) => (
              <ListboxButton key={lang.code} className={MENU_TRIGGER_STYLES}>
                <p className="flex gap-2 items-center overflow-hidden whitespace-nowrap">
                  <span className="text-sm">{lang.name}</span>
                  <span className="text-ellipsis overflow-hidden text-zinc-400 text-xs">{lang.credits}</span>
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
                  className="h-40 flex flex-col bg-zinc-950/50 backdrop-blur-md border border-zinc-400/5 shadow-sm shadow-zinc-950/50 hover:shadow-none rounded-sm overflow-y-scroll"
                >
                  {languages.map((lang) => (
                    <ListboxOption
                      key={lang.code}
                      value={lang.code}
                      as={motion.li}
                      variants={DROPDOWN_MENU_ITEM_VARIANTS}
                      className={clsx(MENU_OPTION_STYLES, "odd:bg-zinc-800/30 even:bg-zinc-950/30")}
                    >
                      <p className="flex gap-2 items-center overflow-hidden whitespace-nowrap">
                        <span className="text-sm">{lang.name}</span>
                        <span className="text-ellipsis overflow-hidden text-zinc-400 text-xs">{lang.credits}</span>
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

export default LanguagesMenu
