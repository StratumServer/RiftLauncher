import { describe, expect, it } from "vitest"
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react"

import { TaskProvider } from "@renderer/contexts/TaskManagerContext"
import ImportModpackPopup from "@renderer/features/mods/components/ImportModpackPopup"

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
