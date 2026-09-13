import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react"

import { TaskProvider } from "@renderer/contexts/TaskManagerContext"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"
import ImportModpackPopup from "@renderer/features/mods/components/ImportModpackPopup"

import type { ModpackEntry, ModpackRequest } from "@domain/mods/importModpack"

import { installMockWindowApi } from "./helpers/windowApi"
import { renderWithProviders } from "./helpers/render"

/**
 * The import table before anything is clicked (#379).
 *
 * NekoJess read a 200-row table of modids and could not tell what her pack held, nor what the import
 * was about to do to her folder. Both answers exist in the plan already, so this mounts the popup
 * over a manifest with one row of every kind and reads the table without pressing Import.
 */

const GAME_VERSION = "1.20.4"

function detailResponse(name: string, modversions: string[]): string {
  return JSON.stringify({
    statuscode: "200",
    mod: {
      modid: 1,
      assetid: 100,
      name,
      tags: [],
      releases: modversions.map((modversion, index) => ({
        releaseid: index,
        mainfile: `https://mods.vintagestory.at/download?v=${modversion}`,
        filename: `mod-${modversion}.zip`,
        fileid: index + 1,
        modidstr: "mod",
        modversion,
        tags: [`v${GAME_VERSION}`]
      }))
    }
  })
}

const MODDB: Record<string, string> = {
  tradie: detailResponse("Traders Expansion", ["1.4.0"]),
  carryon: detailResponse("Carry On", ["2.0.0", "1.9.0"]),
  primitivesurvival: detailResponse("Primitive Survival", ["3.6.0"]),
  hqzlights: detailResponse("Braziers", ["1.1.0"]),
  ghostmod: detailResponse("Ghost Mod", []),
  alloycalculatorstuzzichino: JSON.stringify({ statuscode: "404" }),
  animationslib: JSON.stringify({ statuscode: "404" })
}

function installation(): InstallationType {
  return {
    id: "main",
    name: "Main",
    icon: "",
    path: "/installations/main",
    version: GAME_VERSION,
    gameVersionId: "gv-1",
    startParams: "",
    backupsLimit: 3,
    backupsAuto: false,
    compressionLevel: 6,
    backups: [],
    lastTimePlayed: 0,
    totalTimePlayed: 0,
    mesaGlThread: false,
    envVars: ""
  }
}

function installedMod(name: string, modid: string, version: string, enabled = true): InstalledModType {
  return { name, modid, version, path: `/installations/main/Mods/${modid}-${version}.zip`, enabled }
}

const MANIFEST: ModpackManifestType = {
  name: "NekoJess pack",
  gameVersion: GAME_VERSION,
  mods: [
    { modid: "tradie", version: "1.4.0", name: "Traders Expansion" },
    { modid: "carryon", version: "2.0.0", name: "Carry On" },
    { modid: "primitivesurvival", version: "3.6.0", name: "Primitive Survival" },
    { modid: "sandwich", version: "2.1.0", name: "Sammiches" },
    { modid: "hqzlights", version: "1.1.0", name: "Braziers" },
    { modid: "alloycalculatorstuzzichino", version: "1.0.4", name: "Alloy Calculator" },
    // No name at all: a pack exported before the name was written.
    { modid: "animationslib", version: "1.2.0" },
    { modid: "ghostmod", version: "1.0.0", name: "Ghost Mod" }
  ]
}

const INSTALLED = [
  installedMod("Carry On", "carryon", "1.9.0"),
  installedMod("Primitive Survival", "primitivesurvival", "3.7.0"),
  installedMod("Sammiches", "sandwich", "2.1.0"),
  installedMod("Braziers", "hqzlights", "1.1.0", false)
]

function mountPopup(): void {
  installMockWindowApi({
    netManager: {
      queryURL: async (url: string) => {
        const modid = url.split("/mod/")[1] ?? ""
        const response = MODDB[modid]
        if (!response) throw new Error(`The popup queried an unexpected mod: ${modid}`)
        return response
      }
    }
  })

  renderWithProviders(
    <TaskProvider>
      <ImportModpackPopup isOpen manifest={MANIFEST} close={(): void => {}} installation={installation()} installedMods={INSTALLED} onFinish={(): void => {}} />
    </TaskProvider>
  )
}

async function rowFor(label: string): Promise<HTMLElement> {
  const row = (await screen.findByText(label)).closest("li")
  if (!row) throw new Error(`No table row found for "${label}".`)
  return row
}

describe("ImportModpackPopup, before Import is clicked", () => {
  it("labels a resolved row with the mod database name and keeps the modid as a second line", async () => {
    mountPopup()

    const row = await rowFor("Traders Expansion")
    expect(within(row).getByText("tradie")).toBeTruthy()
    expect(within(row).getByText("New install")).toBeTruthy()
  })

  it("says an update, from the installed version to the one the pack asks for", async () => {
    mountPopup()

    expect(within(await rowFor("Carry On")).getByText("Update from 1.9.0 to 2.0.0")).toBeTruthy()
  })

  it("says a downgrade, both versions named", async () => {
    mountPopup()

    expect(within(await rowFor("Primitive Survival")).getByText("Downgrade from 3.7.0 to 3.6.0")).toBeTruthy()
  })

  it("says a mod already sitting at the pack's version needs nothing, without ever asking the mod database", async () => {
    mountPopup()

    expect(within(await rowFor("Sammiches")).getByText("Already installed")).toBeTruthy()
  })

  it("warns that a copy the pack does not accept, here a disabled one, will be replaced (#379)", async () => {
    mountPopup()

    expect(within(await rowFor("Braziers")).getByText("The installed copy (1.1.0) will be replaced by 1.1.0")).toBeTruthy()
  })

  it("names an unresolvable mod by the name the pack was exported with, not by its modid", async () => {
    mountPopup()

    const row = await rowFor("Alloy Calculator")
    expect(within(row).getByText("alloycalculatorstuzzichino")).toBeTruthy()
    expect(within(row).getByText("Not on the mod database")).toBeTruthy()
  })

  it("explains what was checked for the mods the database does not declare", async () => {
    mountPopup()

    await rowFor("Alloy Calculator")
    expect(
      screen.getByText(
        "2 mod(s) are not on the mod database: no listing there declares the mod id in any of its releases. Those are most likely forks or private builds, and have to be installed by hand."
      )
    ).toBeTruthy()
  })

  it("falls back to the bare modid for a pack exported before names were written, with no second line", async () => {
    mountPopup()

    const row = await rowFor("animationslib")
    expect(within(row).getAllByText("animationslib").length).toBe(1)
  })

  it("says a mod whose page publishes no release at all cannot be installed", async () => {
    mountPopup()

    expect(within(await rowFor("Ghost Mod")).getByText("No compatible release")).toBeTruthy()
  })

  it("keeps the rows as plain list items, so the second line does not turn one into a control", async () => {
    mountPopup()

    const row = await rowFor("Traders Expansion")
    expect(row.tagName).toBe("LI")
    expect(within(row).queryByRole("button")).toBeNull()
  })
})

/**
 * Closing the popup while the lookups are still out (#384).
 *
 * The lookups now start when the manifest loads, and the main process holds them to six at a
 * time, so a big pack spends real seconds resolving and a player can easily close the popup
 * and open another pack before the first batch has come back. The effect's cancelled flag is
 * what keeps that first batch from landing on the second pack's table.
 *
 * The stale batch is released last on purpose. A resolution that comes back before the fresh
 * one would be overwritten anyway; the one that has to be dropped is the one that arrives
 * after the popup has already been re-opened on something else.
 */
describe("ImportModpackPopup, closed mid-lookup", () => {
  const FIRST: ModpackManifestType = { name: "First pack", gameVersion: GAME_VERSION, mods: [{ modid: "tradie", version: "1.4.0", name: "Traders Expansion" }] }
  const SECOND: ModpackManifestType = { name: "Second pack", gameVersion: GAME_VERSION, mods: [{ modid: "carryon", version: "2.0.0", name: "Carry On" }] }

  it("drops a lookup that comes back after the popup was closed and re-opened on another pack", async () => {
    const held = new Map<string, (response: string) => void>()

    installMockWindowApi({
      netManager: {
        queryURL: (url: string) =>
          new Promise<string>((resolve) => {
            held.set(url.split("/mod/")[1] ?? "", resolve)
          })
      }
    })

    function popup(manifest: ModpackManifestType | null): JSX.Element {
      return (
        <TaskProvider>
          <ImportModpackPopup isOpen={manifest !== null} manifest={manifest} close={(): void => {}} installation={installation()} installedMods={[]} onFinish={(): void => {}} />
        </TaskProvider>
      )
    }

    const { rerender } = renderWithProviders(popup(FIRST))
    await waitFor(() => expect(held.has("tradie")).toBe(true))

    rerender(popup(null))
    rerender(popup(SECOND))
    await waitFor(() => expect(held.has("carryon")).toBe(true))

    await act(async () => {
      held.get("carryon")?.(detailResponse("Carry On", ["2.0.0"]))
    })
    expect(within(await rowFor("Carry On")).getByText("New install")).toBeTruthy()

    await act(async () => {
      held.get("tradie")?.(detailResponse("Traders Expansion", ["1.4.0"]))
    })

    expect(screen.queryByText("Traders Expansion")).toBeNull()
    expect(within(await rowFor("Carry On")).getByText("New install")).toBeTruthy()
  })
})

/**
 * The mod database being unreachable (#384).
 *
 * useQueryMod used to fold a thrown network error into the same "nothing answered" bucket as a
 * clean 404, so an outage read as every unresolved mod being a fork the player has to install by
 * hand. These tests pin the fix: a lookup that never answered is told apart from one that did,
 * shown as its own row status with a way to try again, and a total outage replaces the table
 * rather than drowning it in false "not on the mod database" rows.
 */
describe("ImportModpackPopup, when the mod database cannot be reached", () => {
  const MIXED: ModpackManifestType = {
    name: "Mixed pack",
    gameVersion: GAME_VERSION,
    mods: [
      { modid: "tradie", version: "1.4.0", name: "Traders Expansion" },
      { modid: "unreachablemod", version: "1.0.0", name: "Unreachable Mod" },
      { modid: "trulymissing", version: "1.0.0", name: "Truly Missing" }
    ]
  }

  function mountWith(queryURL: (url: string) => Promise<string>): void {
    installMockWindowApi({ netManager: { queryURL } })
    renderWithProviders(
      <TaskProvider>
        <ImportModpackPopup isOpen manifest={MIXED} close={(): void => {}} installation={installation()} installedMods={[]} onFinish={(): void => {}} />
      </TaskProvider>
    )
  }

  /** Answers one modid of MIXED, throwing instead for whichever ones are named as still down. */
  function respond(modid: string, downFor: ReadonlySet<string> = new Set()): Promise<string> {
    if (downFor.has(modid)) return Promise.reject(new Error("network down"))
    if (modid === "tradie") return Promise.resolve(detailResponse("Traders Expansion", ["1.4.0"]))
    if (modid === "unreachablemod") return Promise.resolve(detailResponse("Unreachable Mod", ["1.0.0"]))
    if (modid === "trulymissing") return Promise.resolve(JSON.stringify({ statuscode: "404" }))
    return Promise.reject(new Error(`The popup queried an unexpected mod: ${modid}`))
  }

  it("tells a lookup that failed apart from a clean 404, and counts each on its own note", async () => {
    mountWith(async (url) => respond(url.split("/mod/")[1] ?? "", new Set(["unreachablemod"])))

    expect(within(await rowFor("Unreachable Mod")).getByText("Couldn't reach the mod database")).toBeTruthy()
    expect(within(await rowFor("Truly Missing")).getByText("Not on the mod database")).toBeTruthy()
    expect(within(await rowFor("Traders Expansion")).getByText("New install")).toBeTruthy()

    // Only the genuine 404 counts toward the fork/private-build note.
    expect(
      screen.getByText(
        "1 mod(s) are not on the mod database: no listing there declares the mod id in any of its releases. Those are most likely forks or private builds, and have to be installed by hand."
      )
    ).toBeTruthy()
    expect(screen.getByText("1 mod(s) could not be checked: the mod database could not be reached.")).toBeTruthy()
  })

  it("shows the whole pack as unreachable, not a table of forks, when every lookup fails", async () => {
    mountWith(async () => Promise.reject(new Error("network down")))

    expect(await screen.findByText("The mod database could not be reached, so none of these mods could be checked yet.")).toBeTruthy()
    // The table, with its "not on the mod database" rows, never renders at all.
    expect(screen.queryByText("Status")).toBeNull()
    expect(screen.queryByText("Not on the mod database")).toBeNull()
  })

  it("retries the failed lookups, and the table replaces the unreachable state once they answer", async () => {
    let down = true
    mountWith(async (url) => (down ? Promise.reject(new Error("network down")) : respond(url.split("/mod/")[1] ?? "")))

    await screen.findByText("The mod database could not be reached, so none of these mods could be checked yet.")

    down = false
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))

    expect(within(await rowFor("Traders Expansion")).getByText("New install")).toBeTruthy()
    expect(within(await rowFor("Truly Missing")).getByText("Not on the mod database")).toBeTruthy()
    expect(screen.queryByText("The mod database could not be reached, so none of these mods could be checked yet.")).toBeNull()
  })

  it("retries a mixed failure back to a resolved row from the note's own retry action", async () => {
    let down = true
    mountWith(async (url) => respond(url.split("/mod/")[1] ?? "", down ? new Set(["unreachablemod"]) : new Set()))

    expect(within(await rowFor("Unreachable Mod")).getByText("Couldn't reach the mod database")).toBeTruthy()

    down = false
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))

    expect(within(await rowFor("Unreachable Mod")).getByText("New install")).toBeTruthy()
  })
})

/**
 * A pack's worth of downloads used to raise a completion toast each, into an overlay that presents
 * one at a time. Thirty of them put the last banner minutes past the end of the import, next to a
 * row table and a summary popup that had already said all of it. The bulk updater had asked for
 * aggregate feedback for exactly this reason since it was written; the import had not.
 */
describe("ImportModpackPopup, while it downloads", () => {
  it("raises no per mod toast, because its own table and summary already report each row", async () => {
    const downloadOnPath = vi.fn(async (_id: string, _url: string, outputPath: string, fileName: string) => `${outputPath}/${fileName}`)
    installMockWindowApi({
      netManager: {
        queryURL: async (url: string) => {
          const modid = url.split("/mod/")[1] ?? ""
          const response = MODDB[modid]
          if (!response) throw new Error(`The popup queried an unexpected mod: ${modid}`)
          return response
        }
      },
      pathsManager: {
        checkPathExists: vi.fn(async () => true),
        deletePath: vi.fn(async () => true),
        downloadOnPath,
        formatPath: vi.fn(async (parts: string[]) => parts.join("/"))
      }
    })

    renderWithProviders(
      <TaskProvider>
        <NotificationsOverlay />
        <ImportModpackPopup isOpen manifest={MANIFEST} close={(): void => {}} installation={installation()} installedMods={INSTALLED} onFinish={(): void => {}} />
      </TaskProvider>
    )

    await screen.findByText("Traders Expansion")
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Import Modpack" })))
    await waitFor(() => expect(screen.queryByText("Importing...")).toBeNull())

    // Not a vacuous pass: the run really did fetch archives, it just said nothing about each one.
    expect(downloadOnPath.mock.calls.length).toBeGreaterThan(1)
    expect(within(screen.getByRole("status")).queryByText(/^Downloaded /)).toBeNull()
  })
})

/**
 * The same table opened on Mods picked on the browse page (#287). A pick names no version: it is
 * looked up by its ModDB listing, planned against the newest release tagged for the installation's
 * series, keeps an installed copy's on or off state, and is worded as an install, not an import.
 */
describe("ImportModpackPopup, on Mods picked on the browse page", () => {
  function pickDetail(name: string, modidstr: string, releases: Array<[string, string[]]>): string {
    return JSON.stringify({
      statuscode: "200",
      mod: {
        modid: 1,
        assetid: 4711,
        name,
        tags: [],
        releases: releases.map(([modversion, tags], index) => ({
          releaseid: index,
          mainfile: `https://mods.example/${modidstr}-${modversion}.zip`,
          filename: `${modidstr}-${modversion}.zip`,
          fileid: index + 1,
          modidstr,
          modversion,
          tags
        }))
      }
    })
  }

  // A continuation of Primitive Survival that kept the original's modid, listed under its own page.
  const FORK_PICK: ModpackEntry = { modid: "primitivesurvival", listingId: 4711, name: "Primitive Survival" }
  const CARRY_ON_PICK: ModpackEntry = { modid: "carryon", listingId: 42, name: "Carry On" }
  const ANSWERS: Record<string, string> = {
    "4711": pickDetail("Primitive Survival Continued", "primitivesurvival", [
      ["3.0.0", ["1.21.0"]],
      ["2.1.0", [GAME_VERSION]]
    ]),
    "42": pickDetail("Carry On", "carryon", [["2.0.0", [GAME_VERSION]]])
  }

  interface PickMount {
    mods?: ModpackEntry[]
    gameVersion?: string
    installedMods?: InstalledModType[]
    leftOut?: number
    installationOverrides?: Partial<InstallationType>
    downloadOnPath?: BridgeAPI["pathsManager"]["downloadOnPath"]
  }

  function mountPicks({ mods = [FORK_PICK], gameVersion = GAME_VERSION, installedMods = [], leftOut = 0, installationOverrides = {}, downloadOnPath }: PickMount = {}): {
    queryURL: ReturnType<typeof vi.fn>
    downloadOnPath: ReturnType<typeof vi.fn>
    deletePath: ReturnType<typeof vi.fn>
    unmount: () => void
  } {
    const queryURL = vi.fn(async (url: string) => {
      const key = url.split("/mod/")[1] ?? ""
      const answer = ANSWERS[key]
      if (!answer) throw new Error(`The popup queried an unexpected mod: ${key}`)
      return answer
    })
    const download = vi.fn<BridgeAPI["pathsManager"]["downloadOnPath"]>(downloadOnPath ?? (async (_id, _url, outputPath, fileName): Promise<string> => `${outputPath}/${fileName}`))
    const deletePath = vi.fn(async () => true)
    installMockWindowApi({
      netManager: { queryURL },
      pathsManager: { checkPathExists: vi.fn(async () => true), deletePath, downloadOnPath: download, formatPath: vi.fn(async (parts: string[]) => parts.join("/")) }
    })

    const request: ModpackRequest = { name: "", gameVersion, mods }
    const { unmount } = renderWithProviders(
      <TaskProvider>
        <NotificationsOverlay />
        <ImportModpackPopup
          isOpen
          manifest={request}
          close={(): void => {}}
          installation={{ ...installation(), ...installationOverrides }}
          installedMods={installedMods}
          onFinish={(): void => {}}
          selection={{ leftOut }}
        />
      </TaskProvider>
    )
    return { queryURL, downloadOnPath: download, deletePath, unmount }
  }

  async function install(): Promise<void> {
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Install" })))
  }

  it("looks each browse pick up by its listing id, not its mod id", async () => {
    const { queryURL } = mountPicks()

    expect(await screen.findByText("Primitive Survival Continued")).toBeTruthy()
    expect(queryURL).toHaveBeenCalledWith("https://mods.vintagestory.at/api/mod/4711")
  })

  it("shows the release a pick would install in the version column", async () => {
    mountPicks()

    const row = await rowFor("Primitive Survival Continued")
    expect(within(row).getByText("2.1.0")).toBeTruthy()
    expect(within(row).getByText("New install")).toBeTruthy()
  })

  it("names a selection run as an install, with no pack version warning and no downgrade banner", async () => {
    mountPicks({ gameVersion: "1.19.0", installedMods: [installedMod("Primitive Survival", "primitivesurvival", "9.0.0")] })

    expect(within(await rowFor("Primitive Survival Continued")).getByText("Already installed")).toBeTruthy()
    expect(screen.getByRole("heading", { name: "Install Selected Mods" })).toBeTruthy()
    expect(screen.getByText("What installing the Mods you picked will do:")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Install" })).toBeTruthy()
    expect(screen.queryByText(/Import Modpack/)).toBeNull()
    expect(screen.queryByText(/made for game version/)).toBeNull()
    expect(screen.queryByText(/will be downgraded/)).toBeNull()
  })

  it("says how many picks were left out, and says nothing when none were", async () => {
    const { unmount } = mountPicks({ leftOut: 1 })
    expect(await screen.findByText("1 picked Mod(s) left out: they declare the same mod id as another pick.")).toBeTruthy()
    unmount()

    mountPicks({ leftOut: 0 })
    await rowFor("Primitive Survival Continued")
    expect(screen.queryByText(/left out/)).toBeNull()
  })

  it("installs the planned picks with no per-mod toast and opens the install summary", async () => {
    let land!: () => void
    const landed = new Promise<void>((resolve) => (land = resolve))
    const { downloadOnPath } = mountPicks({
      mods: [FORK_PICK, CARRY_ON_PICK],
      installedMods: [installedMod("Carry On", "carryon", "2.0.0")],
      downloadOnPath: async (_id, _url, outputPath, fileName) => {
        await landed
        return `${outputPath}/${fileName}`
      }
    })

    expect(within(await rowFor("Carry On")).getByText("Already installed")).toBeTruthy()
    await install()
    expect(await screen.findByRole("button", { name: "Installing..." })).toBeTruthy()

    await act(async () => land())
    expect(await screen.findByRole("heading", { name: "Mod Install Summary" })).toBeTruthy()
    expect(downloadOnPath).toHaveBeenCalledTimes(1)
    expect(downloadOnPath).toHaveBeenCalledWith(expect.any(String), "https://mods.example/primitivesurvival-2.1.0.zip", "/installations/main/Mods", "primitivesurvival-2.1.0.zip")
    expect(within(screen.getByRole("status")).queryByText(/^Downloaded /)).toBeNull()
  })

  it("updates an older disabled pick and leaves it disabled", async () => {
    const disabled = { ...installedMod("Primitive Survival", "primitivesurvival", "1.0.0", false), path: "/installations/main/Mods/primitivesurvival-1.0.0.zip.disabled" }
    const { downloadOnPath, deletePath } = mountPicks({ installedMods: [disabled] })

    expect(within(await rowFor("Primitive Survival Continued")).getByText("Update from 1.0.0 to 2.1.0")).toBeTruthy()
    await install()

    expect(await screen.findByRole("heading", { name: "Mod Install Summary" })).toBeTruthy()
    expect(deletePath).toHaveBeenCalledWith("/installations/main/Mods/primitivesurvival-1.0.0.zip.disabled")
    expect(downloadOnPath).toHaveBeenCalledWith(expect.any(String), "https://mods.example/primitivesurvival-2.1.0.zip", "/installations/main/Mods", "primitivesurvival-2.1.0.zip.disabled")
  })

  it("refuses to run while Update all holds the Installation's Mods folder", async () => {
    const { downloadOnPath } = mountPicks({ installationOverrides: { _updatingMods: true } })

    await rowFor("Primitive Survival Continued")
    await install()

    expect(await screen.findByText("You can't update a Mod while it's in use.")).toBeTruthy()
    expect(downloadOnPath).not.toHaveBeenCalled()
  })
})
