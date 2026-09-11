import { describe, expect, it, vi } from "vitest"
import type { ReactElement, ReactNode } from "react"
import { act, renderHook, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router-dom"

import ManageMods from "@renderer/features/installations/pages/ManageMods"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"
import { NotificationsProvider } from "@renderer/contexts/NotificationsContext"
import { ConfigProvider } from "@renderer/features/config/contexts/ConfigContext"
import { useModProfiles } from "@renderer/features/mods/hooks/useModProfiles"

import { createMockConfig, installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * Mod profiles on the Manage Mods page (#287): the Profiles dialog, and a switch end to end against
 * a fake Mods folder that really renames, so a rescan after a switch sees what the switch did.
 *
 * Its own file so it does not collide with the open edits to manageMods.test.tsx.
 */

const MODS = "/games/a/Mods"
const ALPHA = `${MODS}/alpha-1.0.0.zip`
const BETA = `${MODS}/beta-2.0.0.zip`
const GAMMA = `${MODS}/gamma-3.0.0.zip`
const DELTA = `${MODS}/delta-4.0.0.zip`
const EPSILON = `${MODS}/epsilon-5.0.0.zip.disabled`

const PROFILES_BUTTON = "Mod profiles: save the Mods that are on as a named set, and switch between sets"
const USE = "Use this profile: turn Mods on and off until the folder matches it"
const CREATE = "Save the Mods that are on right now as a new profile, and make it the active one"
const NEW_NAME = "Save the current Mods as a profile"
const NO_PROFILE_NOTE = "No profile is active. The Mods folder stays as it is until you use one."
const IN_USE = "You can't switch profiles while this Installation is being played, backed up, restored or having its Mods updated."
const FOLDER_UNREADABLE = "Couldn't read this Installation's Mods folder, so nothing was recorded or changed."
const SEARCH_PLACEHOLDER = "Search by name, id or author"

function anInstallation(overrides: Partial<InstallationType> = {}): InstallationType {
  return {
    id: "install-a",
    name: "Install A",
    icon: "icon-1",
    path: "/games/a",
    version: "1.20.0",
    gameVersionId: "gv-1",
    startParams: "",
    backupsLimit: 3,
    backupsAuto: false,
    compressionLevel: 6,
    backups: [],
    lastTimePlayed: -1,
    totalTimePlayed: 0,
    mesaGlThread: false,
    envVars: "",
    _modsCount: 0,
    ...overrides
  }
}

function aMod(name: string, modid: string, path: string, enabled = true): InstalledModType {
  return { name, modid, version: "1.0.0", path, enabled, authors: [], contributors: [] }
}

/** Four Mods on, one off. Delta's modid shares nothing with its name. */
function aFolder(): InstalledModType[] {
  return [aMod("Alpha Mod", "alpha", ALPHA), aMod("Beta Mod", "beta", BETA), aMod("Gamma Mod", "gamma", GAMMA), aMod("Delta Mod", "quirkid", DELTA), aMod("Epsilon Mod", "epsilon", EPSILON, false)]
}

/** What the folder above records as a profile. */
const LIVE: ModProfileEntry[] = [
  { modid: "alpha", file: "alpha-1.0.0.zip" },
  { modid: "beta", file: "beta-2.0.0.zip" },
  { modid: "gamma", file: "gamma-3.0.0.zip" },
  { modid: "quirkid", file: "delta-4.0.0.zip" }
]

const SERVER: ModProfile = {
  id: "server",
  name: "Server",
  mods: [
    { modid: "alpha", file: "alpha-1.0.0.zip" },
    { modid: "beta", file: "beta-2.0.0.zip" }
  ]
}

/** Alpha stays on, Epsilon comes on, and Zeta is no longer installed. */
const SOLO: ModProfile = {
  id: "solo",
  name: "Solo",
  mods: [
    { modid: "alpha", file: "alpha-1.0.0.zip" },
    { modid: "epsilon", file: "epsilon-5.0.0.zip" },
    { modid: "zeta", file: "zeta-1.0.0.zip" }
  ]
}

function aDocument(profiles: ModProfile[], activeProfileId: string | null): ModProfilesDocument {
  return { format: 1, activeProfileId, profiles }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

interface Harness {
  user: ReturnType<typeof userEvent.setup>
  /** Every scan, rename and save, in the order the host saw them. */
  events: string[]
  setModEnabled: ReturnType<typeof vi.fn<BridgeAPI["modsManager"]["setModEnabled"]>>
  saveModProfiles: ReturnType<typeof vi.fn<BridgeAPI["modsManager"]["saveModProfiles"]>>
  /** Paths whose rename the fake host refuses. */
  refused: Set<string>
  stored(): ModProfilesDocument
  /** From now on every scan finds the Mods folder out of reach, as a linked folder on a disk that is not mounted. */
  takeFolderOffline(): void
}

function renderProfiles({
  mods = aFolder(),
  document = aDocument([], null),
  installation = anInstallation(),
  read,
  saveAnswers = []
}: {
  mods?: InstalledModType[]
  document?: ModProfilesDocument
  installation?: InstallationType
  read?: ModProfilesReadResult
  /** Answers for the first saves, in order. Every save after them lands. */
  saveAnswers?: ModProfilesSaveResult[]
} = {}): Harness {
  const events: string[] = []
  const refused = new Set<string>()
  let folder = mods
  let stored = clone(document)
  let offline = false

  const setModEnabled = vi.fn<BridgeAPI["modsManager"]["setModEnabled"]>(async (path, enabled) => {
    events.push(`rename ${path} ${enabled}`)
    if (refused.has(path) || !folder.some((mod) => mod.path === path)) return { ok: false, reason: "refused" }
    const next = enabled ? path.replace(/\.disabled$/, "") : `${path}.disabled`
    folder = folder.map((mod) => (mod.path === path ? { ...mod, path: next, enabled } : mod))
    return { ok: true, path: next }
  })

  const saveModProfiles = vi.fn<BridgeAPI["modsManager"]["saveModProfiles"]>(async (_path, next) => {
    events.push(`save ${next.activeProfileId}`)
    const answer = saveAnswers.shift() ?? { ok: true }
    if (answer.ok) stored = clone(next)
    return answer
  })

  installMockWindowApi({
    configManager: { getConfig: vi.fn(async () => createMockConfig({ installations: [installation] })) },
    netManager: { queryURL: vi.fn(async () => JSON.stringify({ statuscode: "404" })) },
    modsManager: {
      getInstalledMods: vi.fn(async (): Promise<InstalledModsScan> => {
        events.push("scan")
        if (offline) return { mods: [], errors: [], unreadable: true }
        return { mods: folder.map((mod) => ({ ...mod })), errors: [{ zipname: "broken.zip", path: `${MODS}/broken.zip` }] }
      }),
      setModEnabled,
      getModProfiles: vi.fn(async () => read ?? { ok: true as const, document: clone(stored) }),
      saveModProfiles
    }
  })

  renderWithProviders(
    <Routes>
      <Route
        path="/installations/mods/:id"
        element={
          <TaskProvider>
            <ManageMods />
            <NotificationsOverlay />
          </TaskProvider>
        }
      />
    </Routes>,
    { route: "/installations/mods/install-a" }
  )

  return {
    user: userEvent.setup(),
    events,
    setModEnabled,
    saveModProfiles,
    refused,
    stored: () => stored,
    takeFolderOffline: (): void => {
      offline = true
    }
  }
}

function profilesButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: PROFILES_BUTTON, hidden: true }) as HTMLButtonElement
}

/** Opens the dialog once the page has scanned the folder, and waits for the profiles to be listed. */
async function openProfiles(user: Harness["user"], waitForName?: string): Promise<HTMLElement> {
  await screen.findAllByText("Alpha Mod", {}, { timeout: 3000 })
  await user.click(profilesButton())
  const dialog = await screen.findByRole("dialog")
  if (waitForName) await within(dialog).findByText(waitForName, { selector: "span" })
  return dialog
}

function rowOf(dialog: HTMLElement, name: string): HTMLElement {
  return within(dialog).getByText(name, { selector: "span" }).closest("li") as HTMLElement
}

function useButtonOf(dialog: HTMLElement, name: string): HTMLButtonElement {
  return within(rowOf(dialog, name)).getByRole("button", { name: USE }) as HTMLButtonElement
}

function buttonWithText(text: string): HTMLButtonElement {
  return screen.getByText(text).closest("button") as HTMLButtonElement
}

/**
 * The toasts on screen. The dialog hides the page it sits over from assistive technology, and the
 * toasts live in that page, so the query has to look past `aria-hidden` or it would find none.
 */
function toasts(): HTMLElement[] {
  return screen.queryAllByRole("button", { name: "Discard notification", hidden: true })
}

/** One toast shows at a time, so the next one only appears once this one is gone. */
async function discardToast(user: Harness["user"]): Promise<void> {
  await waitFor(() => expect(toasts()).toHaveLength(1))
  await user.click(toasts()[0] as HTMLElement)
  await waitFor(() => expect(toasts()).toHaveLength(0))
}

/** A switch is over once the page has rescanned, which is when the Profiles button comes back. */
async function switchLanded(): Promise<void> {
  await waitFor(() => expect(profilesButton().disabled).toBe(false))
  await screen.findAllByText("Alpha Mod", {}, { timeout: 3000 })
}

describe("Mod profiles", { timeout: 20000 }, () => {
  it("offers the Profiles button with no profile yet, and explains what the first one saves", async () => {
    const { user } = renderProfiles()

    await screen.findByText("Alpha Mod", {}, { timeout: 3000 })
    expect(profilesButton().textContent).toContain("No profile")
    const dialog = await openProfiles(user)

    expect(within(dialog).getByText("Your first profile saves the Mods that are on right now.")).toBeTruthy()
    expect(within(dialog).queryAllByRole("listitem")).toHaveLength(0)
    // No profile at all is not "none of them active".
    expect(screen.queryByText(NO_PROFILE_NOTE)).toBeNull()
  })

  it("saves the enabled Mods as a new profile and marks it active", async () => {
    const { user, saveModProfiles, setModEnabled } = renderProfiles()
    const dialog = await openProfiles(user)

    await user.type(within(dialog).getByLabelText(NEW_NAME), "  Server ")
    await user.click(within(dialog).getByRole("button", { name: CREATE }))

    await waitFor(() => expect(saveModProfiles).toHaveBeenCalledTimes(1))
    const [path, saved] = saveModProfiles.mock.calls[0] as [string, ModProfilesDocument]
    expect(path).toBe("/games/a")
    // Every Mod that is on, not the disabled Epsilon, and no unreadable archive.
    expect(saved.profiles).toEqual([{ id: saved.activeProfileId, name: "Server", mods: LIVE }])
    expect(saved.activeProfileId).toMatch(/^[A-Za-z0-9-]{1,64}$/)

    await waitFor(() => expect(useButtonOf(dialog, "Server").getAttribute("aria-pressed")).toBe("true"))
    expect((within(dialog).getByLabelText(NEW_NAME) as HTMLInputElement).value).toBe("")
    expect(profilesButton().textContent).toContain("Server")
    expect(setModEnabled).not.toHaveBeenCalled()
  })

  it("creating while another profile is active records that one's live Mods in the same write", async () => {
    const { user, saveModProfiles } = renderProfiles({ document: aDocument([SERVER], "server") })
    const dialog = await openProfiles(user, "Server")

    await user.type(within(dialog).getByLabelText(NEW_NAME), "Creative")
    await user.click(within(dialog).getByRole("button", { name: CREATE }))

    await waitFor(() => expect(saveModProfiles).toHaveBeenCalledTimes(1))
    const saved = saveModProfiles.mock.calls[0]?.[1] as ModProfilesDocument
    expect(saved.profiles.map((profile) => [profile.name, profile.mods])).toEqual([
      ["Server", LIVE],
      ["Creative", LIVE]
    ])
    expect(saved.activeProfileId).toBe(saved.profiles[1]?.id)
  })

  it("refuses an empty, taken or over-long name inline and writes nothing", async () => {
    const { user, saveModProfiles } = renderProfiles({ document: aDocument([SERVER], "server") })
    const dialog = await openProfiles(user, "Server")
    const field = within(dialog).getByLabelText(NEW_NAME)

    await user.type(field, "   ")
    await user.click(within(dialog).getByRole("button", { name: CREATE }))
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Give the profile a name.")

    await user.clear(field)
    // Typing clears the message until the next submit.
    expect(within(dialog).queryByRole("alert")).toBeNull()
    await user.type(field, "SERVER{Enter}")
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Another profile already has this name.")

    await user.clear(field)
    await user.type(field, `${"n".repeat(65)}{Enter}`)
    expect((await within(dialog).findByRole("alert")).textContent).toBe("A profile name can be at most 64 characters long.")

    expect(saveModProfiles).not.toHaveBeenCalled()
  })

  it("records hidden Mods and switches hidden Mods while a search is active", async () => {
    const { user, saveModProfiles, setModEnabled } = renderProfiles({ document: aDocument([SOLO], null) })

    await screen.findByText("Alpha Mod", {}, { timeout: 3000 })
    await user.type(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), "alpha")
    await waitFor(() => expect(screen.queryByText("Beta Mod")).toBeNull())

    const dialog = await openProfiles(user, "Solo")
    await user.type(within(dialog).getByLabelText(NEW_NAME), "Everything{Enter}")
    await waitFor(() => expect(saveModProfiles).toHaveBeenCalledTimes(1))
    expect((saveModProfiles.mock.calls[0]?.[1] as ModProfilesDocument).profiles[1]?.mods).toEqual(LIVE)

    await user.click(useButtonOf(dialog, "Solo"))
    expect(await screen.findByText(/^Switched to Solo/)).toBeTruthy()
    expect(setModEnabled.mock.calls).toEqual([
      [BETA, false],
      [GAMMA, false],
      [DELTA, false],
      [EPSILON, true]
    ])
  })

  it("switching renames exactly what differs, records the outgoing profile first, then marks the target active, with one success notification", async () => {
    const { user, events, stored } = renderProfiles({ document: aDocument([SERVER, SOLO], "server") })
    const dialog = await openProfiles(user, "Solo")
    expect(profilesButton().textContent).toContain("Server")

    events.length = 0
    await user.click(useButtonOf(dialog, "Solo"))

    expect(
      await screen.findByText("Switched to Solo: 1 Mods turned on, 3 turned off. 1 Mods it lists were left alone, because they are no longer installed or more than one copy could match.")
    ).toBeTruthy()
    await switchLanded()

    // A fresh scan, the first write, only the four renames that differ, the second write, and the
    // page's own rescan once the folder is let go.
    expect(events).toEqual(["scan", "save null", `rename ${BETA} false`, `rename ${GAMMA} false`, `rename ${DELTA} false`, `rename ${EPSILON} true`, "save solo", "scan"])
    // Server kept what the folder held when it was left, not its stale stored pair.
    expect(stored()).toEqual(aDocument([{ ...SERVER, mods: LIVE }, SOLO], "solo"))

    expect(useButtonOf(dialog, "Solo").getAttribute("aria-pressed")).toBe("true")
    expect(useButtonOf(dialog, "Server").getAttribute("aria-pressed")).toBe("false")
    expect(profilesButton().textContent).toContain("Solo")
    // One verdict for the whole switch, and the individual renames raise none.
    expect(toasts()).toHaveLength(1)
    expect(screen.queryByText(/is disabled and will not be loaded/)).toBeNull()
  })

  it("a half-failed switch leaves no profile active, says so once, and a second switch renames only the rest", async () => {
    const { user, setModEnabled, saveModProfiles, refused, stored } = renderProfiles({ document: aDocument([SERVER, SOLO], "server") })
    refused.add(GAMMA)
    const dialog = await openProfiles(user, "Solo")
    const logMessage = vi.mocked(window.api.utils.logMessage)
    logMessage.mockClear()

    await user.click(useButtonOf(dialog, "Solo"))

    expect(await screen.findByText("Switching to Solo did not finish: 1 Mods kept their state. No profile is active until you switch again.")).toBeTruthy()
    await switchLanded()
    expect(screen.queryByText(/^Switched to/)).toBeNull()
    // Only the first write happened, and both stored sets are intact.
    expect(saveModProfiles).toHaveBeenCalledTimes(1)
    expect(stored()).toEqual(aDocument([{ ...SERVER, mods: LIVE }, SOLO], null))
    expect(screen.getAllByText(NO_PROFILE_NOTE)).toHaveLength(2)
    expect(profilesButton().textContent).toContain("No profile")

    // The log carries counts, never a profile, a Mod or a path.
    const lines = logMessage.mock.calls.map((call) => call.join(" "))
    expect(lines.filter((line) => /Solo|Server|Mod\b|\/games\/a/.test(line.replace(/\[.*?\]/g, "")))).toEqual([])
    expect(lines.filter((line) => line.includes("Profile switch: 1 on, 2 off, 1 failed, 1 missing, 0 unresolved."))).toHaveLength(1)

    // The toast sits outside the dialog, so dismissing it is a click outside, which closes the dialog.
    await discardToast(user)
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    refused.clear()
    setModEnabled.mockClear()
    const reopened = await openProfiles(user, "Solo")
    expect(within(reopened).getByText(NO_PROFILE_NOTE)).toBeTruthy()
    await user.click(useButtonOf(reopened, "Solo"))

    expect(await screen.findByText(/^Switched to Solo: 0 Mods turned on, 1 turned off\./)).toBeTruthy()
    expect(setModEnabled.mock.calls).toEqual([[GAMMA, false]])
    // No profile was active, so nothing was recorded over Server with the mixed folder.
    expect(stored()).toEqual(aDocument([{ ...SERVER, mods: LIVE }, SOLO], "solo"))
  })

  it("stops before any rename when the outgoing profile cannot be recorded", async () => {
    const { user, setModEnabled, stored } = renderProfiles({ document: aDocument([SERVER, SOLO], "server"), saveAnswers: [{ ok: false, reason: "refused" }] })
    const dialog = await openProfiles(user, "Solo")

    await user.click(useButtonOf(dialog, "Solo"))

    expect(await screen.findByText("Couldn't record the current profile, so nothing was changed.")).toBeTruthy()
    await switchLanded()
    expect(setModEnabled).not.toHaveBeenCalled()
    expect(stored()).toEqual(aDocument([SERVER, SOLO], "server"))
    expect(useButtonOf(dialog, "Server").getAttribute("aria-pressed")).toBe("true")
  })

  it("says the switch was applied but not recorded when the last write fails", async () => {
    const { user, setModEnabled, stored } = renderProfiles({ document: aDocument([SERVER, SOLO], "server"), saveAnswers: [{ ok: true }, { ok: false, reason: "refused" }] })
    const dialog = await openProfiles(user, "Solo")

    await user.click(useButtonOf(dialog, "Solo"))

    expect(await screen.findByText("The Mods now match Solo, but it couldn't be recorded as the active profile.")).toBeTruthy()
    await switchLanded()
    expect(setModEnabled).toHaveBeenCalledTimes(4)
    expect(screen.queryByText(/^Switched to/)).toBeNull()
    expect(stored().activeProfileId).toBeNull()
    expect(profilesButton().textContent).toContain("No profile")
  })

  it("shows a profile name in the verdict exactly as the player typed it", async () => {
    const named: ModProfile = { ...SOLO, id: "named", name: `Mods & "more" <3` }
    const { user } = renderProfiles({ document: aDocument([SERVER, named], "server") })
    const dialog = await openProfiles(user, named.name)

    await user.click(useButtonOf(dialog, named.name))

    expect(await screen.findByText(/^Switched to Mods & "more" <3: 1 Mods turned on, 3 turned off\./)).toBeTruthy()
  })

  it.each([
    ["did not finish", GAMMA, [], `Switching to Mods & "more" <3 did not finish: 1 Mods kept their state. No profile is active until you switch again.`],
    ["was not recorded", null, [{ ok: true }, { ok: false, reason: "refused" }], `The Mods now match Mods & "more" <3, but it couldn't be recorded as the active profile.`]
  ] as const)("shows a profile name exactly as typed when a switch %s", async (_case, refuse, saveAnswers, verdict) => {
    const named: ModProfile = { ...SOLO, id: "named", name: `Mods & "more" <3` }
    const { user, refused } = renderProfiles({ document: aDocument([SERVER, named], "server"), saveAnswers: [...saveAnswers] })
    if (refuse) refused.add(refuse)
    const dialog = await openProfiles(user, named.name)

    await user.click(useButtonOf(dialog, named.name))

    expect(await screen.findByText(verdict)).toBeTruthy()
  })

  it("says a Mod it lists was left alone when two copies share its modid and neither is the one it recorded", async () => {
    const newer = `${MODS}/alpha-1.1.0.zip.disabled`
    const mods = [aMod("Alpha Mod", "alpha", ALPHA), aMod("Alpha Mod", "alpha", newer, false), aMod("Beta Mod", "beta", BETA)]
    const pinned: ModProfile = { id: "pinned", name: "Pinned", mods: [{ modid: "alpha", file: "alpha-0.9.0.zip" }] }
    const { user, setModEnabled } = renderProfiles({ mods, document: aDocument([SERVER, pinned], "server") })
    const dialog = await openProfiles(user, "Pinned")

    await user.click(useButtonOf(dialog, "Pinned"))

    expect(
      await screen.findByText("Switched to Pinned: 0 Mods turned on, 1 turned off. 1 Mods it lists were left alone, because they are no longer installed or more than one copy could match.")
    ).toBeTruthy()
    expect(setModEnabled.mock.calls).toEqual([[BETA, false]])
  })

  it("with two archives of one modid, turns on the one the profile recorded and off the other", async () => {
    const newer = `${MODS}/alpha-1.1.0.zip.disabled`
    const mods = [aMod("Alpha Mod", "alpha", ALPHA), aMod("Alpha Mod", "alpha", newer, false), aMod("Beta Mod", "beta", BETA)]
    const updated: ModProfile = { id: "updated", name: "Updated", mods: [{ modid: "alpha", file: "alpha-1.1.0.zip" }] }
    const { user, setModEnabled, stored } = renderProfiles({ mods, document: aDocument([SERVER, updated], "server") })
    const dialog = await openProfiles(user, "Updated")

    await user.click(useButtonOf(dialog, "Updated"))

    expect(await screen.findByText("Switched to Updated: 1 Mods turned on, 2 turned off.")).toBeTruthy()
    expect(setModEnabled.mock.calls).toEqual([
      [ALPHA, false],
      [newer, true],
      [BETA, false]
    ])
    // Server recorded the copy that was on, by its file, and not the other one.
    expect(stored().profiles[0]?.mods).toEqual([
      { modid: "alpha", file: "alpha-1.0.0.zip" },
      { modid: "beta", file: "beta-2.0.0.zip" }
    ])
  })

  it.each([["_playing"], ["_backuping"], ["_restoringBackup"], ["_updatingMods"]] as const)("refuses to switch while %s is set, touching neither archives nor the file", async (flag) => {
    const { user, setModEnabled, saveModProfiles } = renderProfiles({ document: aDocument([SERVER, SOLO], "server"), installation: anInstallation({ [flag]: true }) })

    await user.click(await screen.findByRole("button", { name: PROFILES_BUTTON }, { timeout: 3000 }))
    const dialog = await screen.findByRole("dialog")
    await within(dialog).findByText("Solo", { selector: "span" })
    await user.click(useButtonOf(dialog, "Solo"))

    expect(await screen.findByText(IN_USE)).toBeTruthy()
    expect(setModEnabled).not.toHaveBeenCalled()
    expect(saveModProfiles).not.toHaveBeenCalled()
  })

  it("records and renames nothing when the switch finds the Mods folder out of reach", async () => {
    const { user, setModEnabled, saveModProfiles, stored, takeFolderOffline } = renderProfiles({ document: aDocument([SERVER, SOLO], "server") })
    const dialog = await openProfiles(user, "Solo")
    takeFolderOffline()

    await user.click(useButtonOf(dialog, "Solo"))

    expect(await screen.findByText(FOLDER_UNREADABLE)).toBeTruthy()
    await waitFor(() => expect(profilesButton().disabled).toBe(false))
    expect(setModEnabled).not.toHaveBeenCalled()
    expect(saveModProfiles).not.toHaveBeenCalled()
    // Server keeps its stored set, and stays the profile in use.
    expect(stored()).toEqual(aDocument([SERVER, SOLO], "server"))
    expect(useButtonOf(dialog, "Server").getAttribute("aria-pressed")).toBe("true")
    expect(screen.queryByText(/^Switched to/)).toBeNull()
  })

  it.each([["create"], ["duplicate"]] as const)("does not %s a profile from a Mods folder out of reach", async (action) => {
    const { user, saveModProfiles, takeFolderOffline } = renderProfiles({ document: aDocument([SERVER], "server") })
    const dialog = await openProfiles(user, "Server")
    takeFolderOffline()

    if (action === "create") await user.type(within(dialog).getByLabelText(NEW_NAME), "Fresh{Enter}")
    else await user.click(within(rowOf(dialog, "Server")).getByRole("button", { name: "Duplicate this profile" }))

    expect(await screen.findByText(FOLDER_UNREADABLE)).toBeTruthy()
    expect(saveModProfiles).not.toHaveBeenCalled()
  })

  it("one quick double press on Use starts one switch, and holds Update all and Import while it runs", async () => {
    const { user, setModEnabled, saveModProfiles } = renderProfiles({ document: aDocument([SERVER, SOLO], "server") })
    const landings: (() => void)[] = []
    setModEnabled.mockImplementation((path) => new Promise<SetModEnabledResult>((resolve) => landings.push(() => resolve({ ok: true, path }))))
    const dialog = await openProfiles(user, "Solo")
    const use = useButtonOf(dialog, "Solo")

    // Both presses inside one commit, before React has painted anything the first one changed.
    await act(async () => {
      use.click()
      use.click()
    })
    await waitFor(() => expect(setModEnabled).toHaveBeenCalledTimes(4))
    // The switch holds the Installation's Mods as busy: the page says so, and the rows, with every
    // action on them, are gone until the renames are done.
    expect(screen.getByText("Updating installed Mods!")).toBeTruthy()
    expect(screen.queryByText("Gamma Mod")).toBeNull()
    expect(buttonWithText("Update all").disabled).toBe(true)
    expect(buttonWithText("Import Modpack").disabled).toBe(true)
    expect(useButtonOf(dialog, "Server").disabled).toBe(true)

    await act(async () => {
      for (const land of landings) land()
    })
    expect(await screen.findByText(/^Switched to Solo/)).toBeTruthy()
    await switchLanded()
    expect(setModEnabled).toHaveBeenCalledTimes(4)
    expect(saveModProfiles).toHaveBeenCalledTimes(2)
    expect(buttonWithText("Update all").disabled).toBe(false)
  })

  it("does nothing when the active profile is used again", async () => {
    const { user, setModEnabled, saveModProfiles } = renderProfiles({ document: aDocument([SERVER, SOLO], "server") })
    const dialog = await openProfiles(user, "Server")

    await user.click(useButtonOf(dialog, "Server"))

    expect(setModEnabled).not.toHaveBeenCalled()
    expect(saveModProfiles).not.toHaveBeenCalled()
    expect(toasts()).toHaveLength(0)
  })

  it("waits for a single Mod's rename before letting a switch start", async () => {
    const { user, setModEnabled } = renderProfiles({ document: aDocument([SERVER, SOLO], "server") })
    let land: () => void = () => {}
    setModEnabled.mockImplementationOnce((path) => new Promise<SetModEnabledResult>((resolve) => (land = (): void => resolve({ ok: true, path: `${path}.disabled` }))))

    await screen.findByText("Alpha Mod", {}, { timeout: 3000 })
    await user.click(within(screen.getByText("Gamma Mod").closest("li") as HTMLElement).getByTitle("Disable this Mod: it stays installed, Vintage Story just won't load it"))
    const dialog = await openProfiles(user, "Solo")
    expect(useButtonOf(dialog, "Solo").disabled).toBe(true)

    await act(async () => land())
    await waitFor(() => expect(useButtonOf(dialog, "Solo").disabled).toBe(false))
  })

  it("renames a profile without touching an archive or which one is active", async () => {
    const { user, setModEnabled, saveModProfiles, stored } = renderProfiles({ document: aDocument([SERVER, SOLO], "server") })
    const dialog = await openProfiles(user, "Solo")

    await user.click(within(rowOf(dialog, "Solo")).getByRole("button", { name: "Rename this profile" }))
    const field = within(dialog).getByLabelText("Profile name")
    await waitFor(() => expect(document.activeElement).toBe(field))
    await user.clear(field)
    await user.type(field, "server{Enter}")
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Another profile already has this name.")
    expect(saveModProfiles).not.toHaveBeenCalled()

    await user.clear(field)
    await user.type(field, "Solo world{Enter}")
    await within(dialog).findByText("Solo world", { selector: "span" })

    expect(stored()).toEqual(aDocument([SERVER, { ...SOLO, name: "Solo world" }], "server"))

    // Its own name in another case is not "taken".
    await user.click(within(rowOf(dialog, "Solo world")).getByRole("button", { name: "Rename this profile" }))
    const again = within(dialog).getByLabelText("Profile name")
    await user.clear(again)
    await user.type(again, "SOLO WORLD{Enter}")
    await within(dialog).findByText("SOLO WORLD", { selector: "span" })
    expect(stored().profiles[1]?.name).toBe("SOLO WORLD")
    expect(setModEnabled).not.toHaveBeenCalled()
  })

  it("duplicates the active profile from the live folder, without activating the copy or renaming anything", async () => {
    const { user, setModEnabled, stored } = renderProfiles({ document: aDocument([SERVER, SOLO], "server") })
    const dialog = await openProfiles(user, "Server")

    await user.click(within(rowOf(dialog, "Server")).getByRole("button", { name: "Duplicate this profile" }))
    await within(dialog).findByText("Server copy", { selector: "span" })
    await user.click(within(rowOf(dialog, "Solo")).getByRole("button", { name: "Duplicate this profile" }))
    await within(dialog).findByText("Solo copy", { selector: "span" })

    const [, , serverCopy, soloCopy] = stored().profiles
    expect(serverCopy?.mods).toEqual(LIVE)
    expect(soloCopy?.mods).toEqual(SOLO.mods)
    expect(stored().activeProfileId).toBe("server")
    expect(setModEnabled).not.toHaveBeenCalled()
  })

  it("deleting the active profile asks first, renames nothing and leaves no profile active", async () => {
    const { user, setModEnabled, saveModProfiles, stored } = renderProfiles({ document: aDocument([SERVER, SOLO], "server") })
    const dialog = await openProfiles(user, "Server")

    await user.click(within(rowOf(dialog, "Server")).getByRole("button", { name: "Delete this profile" }))
    const question = within(dialog)
      .getByText(/Only the profile is removed/)
      .closest("li") as HTMLElement
    // Focus moves onto the question, so a keyboard lands on its answer.
    await waitFor(() => expect(document.activeElement).toBe(within(question).getByRole("button", { name: "Cancel" })))
    await user.click(within(question).getByRole("button", { name: "Cancel" }))
    expect(saveModProfiles).not.toHaveBeenCalled()

    await user.click(within(rowOf(dialog, "Server")).getByRole("button", { name: "Delete this profile" }))
    await user.click(within(dialog).getByRole("button", { name: "Delete" }))

    await waitFor(() => expect(within(dialog).queryByText("Server", { selector: "span" })).toBeNull())
    expect(stored()).toEqual(aDocument([SOLO], null))
    expect(setModEnabled).not.toHaveBeenCalled()
    expect(profilesButton().textContent).toContain("No profile")
    // The row that held focus is gone, so focus goes back to the list.
    await waitFor(() => expect(document.activeElement).toBe(useButtonOf(dialog, "Solo")))
  })

  it("at 50 profiles, disables creating and duplicating and says why", async () => {
    const profiles = Array.from({ length: 50 }, (_, index) => ({ id: `p${index}`, name: `Profile ${index}`, mods: [] }))
    const { user } = renderProfiles({ document: aDocument(profiles, null) })
    const dialog = await openProfiles(user, "Profile 49")

    expect((within(dialog).getByRole("button", { name: CREATE }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(dialog).getByLabelText(NEW_NAME) as HTMLInputElement).disabled).toBe(true)
    expect((within(rowOf(dialog, "Profile 0")).getByRole("button", { name: "Duplicate this profile" }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(dialog).getByText("This Installation already has 50 profiles, the most it can keep. Delete one to save another.")).toBeTruthy()
  })

  it.each([
    ["newer-format", "This Installation's profiles were saved by a newer version of RiftLauncher. This version leaves them untouched: update the launcher to use them."],
    ["unreadable", "This Installation's profiles file can't be read, so profiles are off until it is fixed or removed. The launcher will not overwrite it."],
    ["refused", "Profiles are not available for this Installation."]
  ] as const)("a profiles file the host reads as %s disables every control and is never saved", async (reason, notice) => {
    const { user, saveModProfiles } = renderProfiles({ read: { ok: false, reason } })
    const dialog = await openProfiles(user)

    expect(await within(dialog).findByText(notice)).toBeTruthy()
    expect((within(dialog).getByLabelText(NEW_NAME) as HTMLInputElement).disabled).toBe(true)
    expect((within(dialog).getByRole("button", { name: CREATE }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(dialog).queryAllByRole("listitem")).toHaveLength(0)
    expect(saveModProfiles).not.toHaveBeenCalled()
  })

  it("turns profiles off when a save finds a file it must not overwrite", async () => {
    const { user, saveModProfiles } = renderProfiles({ saveAnswers: [{ ok: false, reason: "newer-format" }] })
    const dialog = await openProfiles(user)

    await user.type(within(dialog).getByLabelText(NEW_NAME), "Server{Enter}")

    expect(await screen.findByText("Couldn't save the profiles. Nothing was changed.")).toBeTruthy()
    expect(await within(dialog).findByText(/saved by a newer version of RiftLauncher/)).toBeTruthy()
    expect((within(dialog).getByRole("button", { name: CREATE }) as HTMLButtonElement).disabled).toBe(true)
    expect(saveModProfiles).toHaveBeenCalledTimes(1)
  })

  it("is reachable and operable by keyboard", async () => {
    const { user, setModEnabled } = renderProfiles({ document: aDocument([SERVER, SOLO], "server") })
    await screen.findByText("Alpha Mod", {}, { timeout: 3000 })
    const button = profilesButton()

    for (let step = 0; step < 40 && document.activeElement !== button; step++) await user.tab()
    expect(document.activeElement).toBe(button)

    await user.keyboard("{Enter}")
    const dialog = await screen.findByRole("dialog")
    await within(dialog).findByText("Solo", { selector: "span" })
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))

    const use = useButtonOf(dialog, "Solo")
    for (let step = 0; step < 20 && document.activeElement !== use; step++) await user.tab()
    expect(document.activeElement).toBe(use)

    await user.keyboard(" ")
    expect(await screen.findByText(/^Switched to Solo/)).toBeTruthy()
    expect(setModEnabled).toHaveBeenCalledTimes(4)
    await switchLanded()

    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(profilesButton()))
  })
})

describe("useModProfiles", () => {
  function wrapper({ children }: { children: ReactNode }): ReactElement {
    return (
      <NotificationsProvider>
        <ConfigProvider>{children}</ConfigProvider>
      </NotificationsProvider>
    )
  }

  it.each([
    ["newer-format", "newer-format"],
    ["unreadable", "unreadable"],
    ["refused", "unavailable"]
  ] as const)("writes nothing after a read of %s, whatever calls it", async (reason, status) => {
    const saveModProfiles = vi.fn<BridgeAPI["modsManager"]["saveModProfiles"]>(async () => ({ ok: true }))
    installMockWindowApi({ modsManager: { getModProfiles: vi.fn(async () => ({ ok: false as const, reason })), saveModProfiles } })
    const { result } = renderHook(() => useModProfiles(anInstallation()), { wrapper })

    await waitFor(() => expect(result.current.status).toBe(status))
    // The dialog disables everything in this state; the hook does not rely on it.
    await act(async () => {
      await result.current.create("Server")
    })

    expect(saveModProfiles).not.toHaveBeenCalled()
  })
})
