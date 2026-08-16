import { useExternalLinks } from "@renderer/hooks/useExternalLinks"

/** Opens `url` in the user's default browser. Thin wrapper over the shared useExternalLinks hook, kept so installations' call sites don't need to change. */
export function useOpenExternalLink(): (url: string) => void {
  return useExternalLinks().openOnBrowser
}
