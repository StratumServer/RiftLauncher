import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { maskValues, redactSensitiveText } from "@domain/redaction"

/**
 * The session report is built from text hundreds of mod authors wrote, read out of a folder full
 * of the player's own paths, and it exists to be pasted into a public thread. This is the test that
 * must not be allowed to go soft (#462).
 */
describe("what the session report may carry out of the process", () => {
  it("strips the paths a game log is full of", () => {
    // The third line of every client log, straight off a real report.
    assert.equal(redactSensitiveText("Process path: C:\\Users\\Will\\AppData\\Roaming\\Vintagestory\\Vintagestory.exe"), "Process path: [PATH]")
    // A Linux player's own data folder.
    assert.equal(redactSensitiveText("Loading assets from /home/jane/.config/VintagestoryData/assets"), "Loading assets from [PATH]")
    // A mod author's build path, which arrives inside a stack frame rather than on its own line.
    assert.equal(
      redactSensitiveText("   at AncientTools.Utility.ModConfig.ReadConfig(ICoreAPI api) in C:\\build\\AncientTools\\src\\utility\\ModConfig.cs:line 32"),
      "   at AncientTools.Utility.ModConfig.ReadConfig(ICoreAPI api) in [PATH] 32"
    )
  })

  it("strips a token-shaped value wherever the game printed one", () => {
    assert.equal(redactSensitiveText("sessionkey=abc123def456 mptoken: zzz"), "sessionkey=[REDACTED] mptoken: [REDACTED]")
  })

  /**
   * #534: a UNC path or a non-standard Linux mount carried the player's OS username straight
   * through, unredacted, because `absolutePathPattern` only recognised a drive letter or a
   * fixed list of Linux roots.
   */
  describe("the shapes #534 added", () => {
    it("strips a backslash UNC path with a trailing file", () => {
      assert.equal(redactSensitiveText(String.raw`open '\\server\share\LeonF\Downloads\vs_install_win-x64_1.22.6.exe'`), "open '[PATH]")
    })

    it("strips a bare backslash UNC path with no file under the share", () => {
      assert.equal(redactSensitiveText(String.raw`share: \\server\share and then more text`), "share: [PATH] and then more text")
    })

    it("strips a forward-slash UNC path with a trailing file", () => {
      assert.equal(redactSensitiveText("share: //server/share/LeonF/file.exe done"), "share: [PATH] done")
    })

    it("strips a bare forward-slash UNC path with no file under the share", () => {
      assert.equal(redactSensitiveText("share: //server/share done"), "share: [PATH] done")
    })

    it("strips a /run/media removable-drive mount", () => {
      assert.equal(redactSensitiveText("mkdir '/run/media/leonf/SANDISK64/vs_install.exe'"), "mkdir '[PATH]")
    })

    it("strips a /media removable-drive mount, spaces in the drive name included", () => {
      assert.equal(redactSensitiveText("unlink '/media/leonf/GameDrive/Vintage Story/Vintagestory.exe'"), "unlink '[PATH]")
    })

    it("leaves a version string that is not part of a path alone", () => {
      const line = "Installed Vintage Story 1.22.6 successfully"
      assert.equal(redactSensitiveText(line), line)
    })

    it("leaves an https URL alone, the // is not a UNC path", () => {
      const line = "Fetching https://mods.vintagestory.at/api/mod/12345 now"
      assert.equal(redactSensitiveText(line), line)
    })

    it("leaves the relative paths logs rely on alone", () => {
      const line = "Loaded mod from mods/AncientTools.dll"
      assert.equal(redactSensitiveText(line), line)
    })

    it("leaves a Windows drive path exactly as already handled", () => {
      assert.equal(redactSensitiveText("Process path: C:\\Users\\Will\\AppData\\Roaming\\Vintagestory\\Vintagestory.exe"), "Process path: [PATH]")
    })

    it("leaves an already-redacted [PATH] token alone", () => {
      const line = "Already redacted marker: [PATH] stays"
      assert.equal(redactSensitiveText(line), line)
    })
  })

  it("masks the player's own email and player name, which no pattern can recognise", () => {
    const line = "Player Jane_Doe (jane.doe@example.com) joined"
    assert.equal(maskValues(line, ["jane.doe@example.com", "Jane_Doe"]), "Player [ACCOUNT] ([ACCOUNT]) joined")
  })

  it("masks whatever the player typed, case and regex characters included", () => {
    assert.equal(maskValues("welcome back JANE_DOE", ["Jane_Doe"]), "welcome back [ACCOUNT]")
    // A name with a regex metacharacter must be matched literally, not compiled as a pattern.
    assert.equal(maskValues("hi a.c and abc", ["a.c"]), "hi [ACCOUNT] and abc")
  })

  it("masks the longest value first, so an email is never left as a masked name plus its domain", () => {
    assert.equal(maskValues("contact jane@example.com now", ["jane", "jane@example.com"]), "contact [ACCOUNT] now")
  })

  it("leaves the text alone when there is nothing safe to mask", () => {
    const line = "Found 24 mods (0 disabled)"
    assert.equal(maskValues(line, []), line)
    assert.equal(maskValues(line, ["  ", "ab"]), line)
  })
})
