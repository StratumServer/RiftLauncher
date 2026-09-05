import { describe, expect, it } from "vitest"
import { screen, within } from "@testing-library/react"

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
