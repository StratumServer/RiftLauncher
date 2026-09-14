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
