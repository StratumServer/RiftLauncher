import clsx from "clsx"
import { AnimatePresence, motion } from "motion/react"
import { Dispatch, SetStateAction, useState } from "react"
import { useTranslation } from "react-i18next"
import { PiCaretDownDuotone } from "react-icons/pi"
import { Combobox, ComboboxButton, ComboboxInput, ComboboxOption, ComboboxOptions } from "@headlessui/react"

import { DROPDOWN_MENU_ITEM_VARIANTS, DROPDOWN_MENU_WRAPPER_VARIANTS } from "@renderer/utils/animateVariants"
import { useAuthorsLookup } from "@renderer/features/mods/hooks/useModDbLookups"
import { BUTTON_BASE_STYLES, BUTTON_VARIANT_STYLES, MENU_OPTION_STYLES } from "@renderer/components/ui/buttonStyles"

function AuthorFilter({
  authorFilter,
  setAuthorFilter,
  size = "w-full h-8"
}: Readonly<{
  authorFilter: DownloadableModAuthorType
  setAuthorFilter: Dispatch<SetStateAction<DownloadableModAuthorType>>
  size?: string
}>): JSX.Element {
  const { t } = useTranslation()

  const authorsList = useAuthorsLookup()
  const [authorsQuery, setAuthorsQuery] = useState<string>("")

  const filteredAuthors =
    authorsQuery === ""
      ? authorsList
      : authorsList.filter((author) => {
          return (author["name"] as string)?.toLowerCase().includes(authorsQuery.toLowerCase())
        })

  return (
    <Combobox value={authorFilter} onChange={(value) => setAuthorFilter(value ?? { userid: "", name: "" })} onClose={() => setAuthorsQuery("")}>
      {({ open }) => (
        <>
          <div className={clsx("flex items-center justify-between rounded-sm overflow-hidden border border-zinc-400/5 bg-zinc-950/50 shadow-sm shadow-zinc-950/50 hover:shadow-none", size)}>
            <ComboboxInput
              placeholder={t("generic.author")}
              displayValue={() => authorFilter?.name || ""}
              onChange={(event) => setAuthorsQuery(event.target.value)}
              className="w-full h-full placeholder:text-zinc-400 bg-transparent outline-hidden pl-2"
            />
            <ComboboxButton className={clsx(BUTTON_BASE_STYLES, BUTTON_VARIANT_STYLES.ghost, "h-full min-h-0 min-w-0 shrink-0 rounded-none px-2")}>
              <PiCaretDownDuotone className={clsx("caret-optical text-zinc-300 shrink-0 duration-200", open && "-rotate-180")} />
            </ComboboxButton>
          </div>

          <AnimatePresence>
            {open && (
              <ComboboxOptions static anchor="bottom start" className="w-36 z-600 mt-1 select-none rounded-sm overflow-hidden">
                <motion.ul
                  variants={DROPDOWN_MENU_WRAPPER_VARIANTS}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="w-full max-h-40 flex flex-col bg-zinc-950/50 backdrop-blur-md border border-zinc-400/5 shadow-sm shadow-zinc-950/50 hover:shadow-none rounded-sm overflow-y-scroll"
                >
                  <>
                    <ComboboxOption
                      as={motion.li}
                      variants={DROPDOWN_MENU_ITEM_VARIANTS}
                      value={undefined}
                      className={clsx(MENU_OPTION_STYLES, "odd:bg-zinc-800/30 whitespace-nowrap text-ellipsis text-sm")}
                    >
                      - {t("generic.everyone")} -
                    </ComboboxOption>
                    {filteredAuthors.slice(0, 20).map((author) => (
                      <ComboboxOption
                        as={motion.li}
                        variants={DROPDOWN_MENU_ITEM_VARIANTS}
                        key={author["userid"]}
                        value={author}
                        className={clsx(MENU_OPTION_STYLES, "odd:bg-zinc-800/30 even:bg-zinc-950/30 whitespace-nowrap text-ellipsis text-sm")}
                      >
                        {author["name"]}
                      </ComboboxOption>
                    ))}
                  </>
                </motion.ul>
              </ComboboxOptions>
            )}
          </AnimatePresence>
        </>
      )}
    </Combobox>
  )
}

export default AuthorFilter
