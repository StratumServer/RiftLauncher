import { describe, expect, it, onTestFinished, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"

import { changeLanguage } from "@renderer/i18n"
import { useBulkUpdateMods } from "@renderer/features/mods/hooks/useBulkUpdateMods"

const addNotification = vi.fn()
const installMod = vi.fn()

vi.mock("@renderer/contexts/NotificationsContext", () => ({ useNotificationsContext: (): { addNotification: typeof addNotification } => ({ addNotification }) }))
vi.mock("@renderer/features/config/contexts/ConfigContext", () => ({
  CONFIG_ACTIONS: { EDIT_INSTALLATION: "EDIT_INSTALLATION" },
  useConfigDispatch: (): ReturnType<typeof vi.fn> => vi.fn(),
  useSuspendedModUpdates: (): string[] => []
}))
vi.mock("@renderer/features/mods/hooks/useInstallMod", () => ({ useInstallMod: (): typeof installMod => installMod }))

const INSTALLATION = { id: "i1", name: "Main", path: "/i1" } as unknown as InstallationType

function updatableMod(modid: string): InstalledModType {
  return {
    modid,
    name: modid,
    version: "1.0.0",
    enabled: true,
    _updatableTo: "2.0.0",
    _mod: { assetid: 1, name: modid, releases: [{ modversion: "2.0.0" }] }
  } as unknown as InstalledModType
}

/** Runs one bulk update where the first `updated` Mods go through and the next `failed` ones do not. */
async function partialToast(updated: number, failed: number): Promise<string> {
  addNotification.mockClear()
  installMod.mockImplementation(
    async ({ modName }: { modName: string }): Promise<{ ok: boolean; reason?: string }> => (Number(modName.slice(1)) < updated ? { ok: true } : { ok: false, reason: "failed" })
  )
  const mods = Array.from({ length: updated + failed }, (_, index) => updatableMod(`m${index}`))

  const { result } = renderHook(() => useBulkUpdateMods(INSTALLATION))
  await act(async () => {
    await result.current.updateAllMods(mods)
  })

  expect(addNotification).toHaveBeenCalledTimes(1)
  return addNotification.mock.calls[0]?.[0] as string
}

const SUMMARY_EN = "The summary says which ones."
const SUMMARY_FR = "Le récapitulatif indique lesquels."

describe("the partial update toast", () => {
  it.each([
    { updated: 1, failed: 1, sentence: "1 Mod updated, 1 left as it was." },
    { updated: 1, failed: 2, sentence: "1 Mod updated, 2 left as they were." },
    { updated: 2, failed: 1, sentence: "2 Mods updated, 1 left as it was." },
    { updated: 2, failed: 2, sentence: "2 Mods updated, 2 left as they were." }
  ])("agrees with both numbers in English ($updated updated, $failed failed)", async ({ updated, failed, sentence }) => {
    expect(await partialToast(updated, failed)).toBe(`${sentence} ${SUMMARY_EN}`)
  })

  it.each([
    { updated: 1, failed: 1, sentence: "1 mod mis à jour, 1 laissé en l'état." },
    { updated: 1, failed: 2, sentence: "1 mod mis à jour, 2 laissés en l'état." },
    { updated: 2, failed: 1, sentence: "2 mods mis à jour, 1 laissé en l'état." },
    { updated: 2, failed: 2, sentence: "2 mods mis à jour, 2 laissés en l'état." }
  ])("agrees with both numbers in French ($updated updated, $failed failed)", async ({ updated, failed, sentence }) => {
    onTestFinished(async () => {
      await changeLanguage("en-US")
    })
    expect(await changeLanguage("fr-FR")).toBe(true)

    expect(await partialToast(updated, failed)).toBe(`${sentence} ${SUMMARY_FR}`)
  })

  it.each([
    { updated: 1, failed: 1, sentence: "1 Mods aktualisiert, 1 blieben, wie sie waren. Die Übersicht sagt, welche." },
    { updated: 2, failed: 3, sentence: "2 Mods aktualisiert, 3 blieben, wie sie waren. Die Übersicht sagt, welche." }
  ])("keeps its own sentence in a language that still has the old one ($updated updated, $failed failed)", async ({ updated, failed, sentence }) => {
    onTestFinished(async () => {
      await changeLanguage("en-US")
    })
    expect(await changeLanguage("de-DE")).toBe(true)

    expect(await partialToast(updated, failed)).toBe(sentence)
  })
})
