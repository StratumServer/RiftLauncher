import { changeLanguage } from "@renderer/i18n"

/**
 * Applies a language switch and logs it, the one preload-bridge touch LanguagesMenu needed.
 *
 * Kept in features/config/hooks rather than under components/ui, where LanguagesMenu.tsx lives,
 * because nothing under src/renderer/src/components may touch the preload bridge directly.
 */
export function useChangeLanguage(): (lang: string) => Promise<boolean> {
  return async function applyLanguageChange(lang: string): Promise<boolean> {
    window.api.utils.logMessage("info", `[front] [localization] [components/ui/LanguagesMenu.tsx] [handleLanguageChange] Changing language to ${lang}.`)
    return changeLanguage(lang)
  }
}
