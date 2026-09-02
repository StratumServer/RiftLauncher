import clsx from "clsx"
import { AnimatePresence, motion } from "motion/react"
import { Dispatch, SetStateAction } from "react"
import { useTranslation } from "react-i18next"
import { PiCaretDownDuotone, PiCheckFatDuotone } from "react-icons/pi"
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "@headlessui/react"

import { DROPDOWN_MENU_ITEM_VARIANTS, DROPDOWN_MENU_WRAPPER_VARIANTS } from "@renderer/utils/animateVariants"
import { useTagsLookup } from "@renderer/features/mods/hooks/useModDbLookups"
import { MENU_OPTION_STYLES, MENU_TRIGGER_STYLES } from "@renderer/components/ui/buttonStyles"

function TagsFilter({
  tagsFilter,
  setTagsFilter,
  size = "w-full h-8"
}: Readonly<{
  tagsFilter: DownloadableModTagType[]
  setTagsFilter: Dispatch<SetStateAction<DownloadableModTagType[]>>
  size?: string
}>): JSX.Element {
  const { t } = useTranslation()

  const tagsList = useTagsLookup()

  return (
    <Listbox value={tagsFilter} onChange={setTagsFilter} multiple>
      {({ open }) => (
        <>
          <ListboxButton className={clsx(MENU_TRIGGER_STYLES, size)} title={tagsFilter.map((tag) => tag.name).join(" · ")}>
            <p className={clsx("flex gap-1 items-center overflow-hidden whitespace-nowrap text-ellipsis overflow-x-scroll scrollbar-none", tagsFilter.length < 1 && "text-zinc-400")}>
              {tagsFilter.length < 1
                ? t("generic.tags")
                : tagsFilter.map((tag) => (
                    <span className="relative text-sm px-1 rounded-sm bg-zinc-850/50 before:content-['#'] before:relative before:mr-1" key={tag.tagid}>
                      {tag.name}
                    </span>
                  ))}
            </p>
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
                  {tagsList.map((tag) => (
                    <ListboxOption
                      key={tag.tagid}
                      value={tag}
                      as={motion.li}
                      variants={DROPDOWN_MENU_ITEM_VARIANTS}
                      className={clsx(MENU_OPTION_STYLES, "odd:bg-zinc-800/30 even:bg-zinc-950/30 whitespace-nowrap text-ellipsis text-sm before:content-['#'] before:relative before:mr-1")}
                    >
                      <p className="flex items-center gap-1">
                        <span className="whitespace-nowrap overflow-hidden text-ellipsis">{tag.name}</span>
                        {tagsFilter.includes(tag) && <PiCheckFatDuotone className="text-zinc-400" />}
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

export default TagsFilter
