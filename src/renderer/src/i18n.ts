import i18n from "i18next"
import { initReactI18next } from "react-i18next"

import enUS from "@renderer/locales/en-US.json"

type TranslationResource = Record<string, unknown>
type LanguageResource = {
  name: string
  credits: string
  translation?: TranslationResource
}
type LocaleModule = { default: unknown }
type LanguageDefinition = LanguageResource & {
  loader?: () => Promise<LocaleModule>
}

const languageDefinitions: Record<string, LanguageDefinition> = {
  "en-US": { name: "English", credits: "by XurxoMF" },
  "es-ES": { name: "Español (España)", credits: "by XurxoMF", loader: () => import("@renderer/locales/es-ES.json") },
  "ru-RU": { name: "Русский", credits: "by megabezdelnik", loader: () => import("@renderer/locales/ru-RU.json") },
  "zh-CN": { name: "简体中文", credits: "by liuyujielol", loader: () => import("@renderer/locales/zh-CN.json") },
  "fr-FR": { name: "Français", credits: "by LorIlcs", loader: () => import("@renderer/locales/fr-FR.json") },
  "de-DE": { name: "Deutsch", credits: "by Brady_The", loader: () => import("@renderer/locales/de-DE.json") },
  "pt-PT": { name: "Português", credits: "by Bruno Cabrita", loader: () => import("@renderer/locales/pt-PT.json") },
  "pt-BR": { name: "Português (Brasil)", credits: "by Paulo Nascimento", loader: () => import("@renderer/locales/pt-BR.json") },
  "nl-NL": { name: "Dutch (Netherlands)", credits: "by Dennisjeee", loader: () => import("@renderer/locales/nl-NL.json") },
  "pl-PL": { name: "Polski", credits: "by Runo Hawk, Zsuatem", loader: () => import("@renderer/locales/pl-PL.json") },
  "it-IT": { name: "Italiano", credits: "by Pingoda", loader: () => import("@renderer/locales/it-IT.json") },
  "hu-HU": { name: "Magyar", credits: "by dobisan", loader: () => import("@renderer/locales/hu-HU.json") },
  "uk-UA": { name: "Українська", credits: "by rXelelo", loader: () => import("@renderer/locales/uk-UA.json") }
}

const resources: Record<string, LanguageResource> = Object.fromEntries(
  Object.entries(languageDefinitions).map(([language, definition]) => [language, { name: definition.name, credits: definition.credits }])
)
const enUSDefinition = languageDefinitions["en-US"]
if (!enUSDefinition) throw new Error("Missing en-US language definition")
resources["en-US"] = {
  name: enUSDefinition.name,
  credits: enUSDefinition.credits,
  translation: enUS as TranslationResource
}

const loadedLanguagePromises = new Map<string, Promise<boolean>>()

function isTranslationResource(value: unknown): value is TranslationResource {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export async function loadLanguage(language: string): Promise<boolean> {
  if (language === "en-US") return true

  const definition = languageDefinitions[language]
  if (!definition?.loader) return false

  const existingPromise = loadedLanguagePromises.get(language)
  if (existingPromise !== undefined) return existingPromise

  const loadingPromise = definition
    .loader()
    .then((module) => {
      const translation = isTranslationResource(module.default) ? module.default : module
      if (!isTranslationResource(translation)) return false
      i18n.addResourceBundle(language, "translation", translation, true, true)
      return true
    })
    .catch(() => false)

  loadedLanguagePromises.set(language, loadingPromise)
  return loadingPromise
}

export async function changeLanguage(language: string): Promise<boolean> {
  if (!(await loadLanguage(language))) return false
  await i18n.changeLanguage(language)
  return true
}

i18n.use(initReactI18next).init({
  resources,
  lng: "en-US",
  fallbackLng: "en-US"
})

export default i18n
