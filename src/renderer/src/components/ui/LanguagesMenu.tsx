import { useState } from "react"
import { useTranslation } from "react-i18next"

import { useChangeLanguage } from "@renderer/features/config/hooks/useChangeLanguage"
import SelectMenu from "@renderer/components/ui/SelectMenu"

function LanguagesMenu(): JSX.Element {
  const { i18n, t } = useTranslation()
  const applyLanguageChange = useChangeLanguage()
  const [selectedLanguage, setSelectedLanguage] = useState<string>(window.localStorage.getItem("lang") || "en-US")

  const resources = i18n.options.resources ?? {}
  const languages = Object.keys(resources).map((code) => ({
    key: code,
    label: typeof resources[code]?.name === "string" ? resources[code].name : code,
    hint: typeof resources[code]?.credits === "string" ? resources[code].credits : t("generic.byAnonymous")
  }))

  async function handleLanguageChange(lang: string): Promise<void> {
    if (!(await applyLanguageChange(lang))) return
    localStorage.setItem("lang", lang)
    setSelectedLanguage(lang)
  }

  // The list outgrows the window at fourteen locales and counting, so this one scrolls.
  return <SelectMenu value={selectedLanguage} options={languages} onChange={handleLanguageChange} size="w-full" listSize="h-40 overflow-y-scroll" />
}

export default LanguagesMenu
