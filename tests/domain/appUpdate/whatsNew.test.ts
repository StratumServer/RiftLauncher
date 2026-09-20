/**
 * releaseNotesToBlocks (a GitHub release body, treated as untrusted text, reduced to headings,
 * paragraphs and bullets), selectReleasesToShow (the dialog's window on the release list) and
 * selectLatestReleases (what Info & Help lists whatever the player has already seen),
 * src/domain/appUpdate/whatsNew.ts.
 *
 * The first describe block runs the reducer over the real bodies of v1.7.0-beta.7, beta.8 and
 * beta.9, saved verbatim under tests/fixtures/releaseNotes. Those are the notes players read, so
 * they are what the block sequence is pinned against; the synthetic cases below them cover the
 * constructs the project has not published yet (ordered lists, tables written without a leading
 * pipe, fences, setext headings, entities) and the caps.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "vitest"

import { DEFAULT_MAX_RELEASES_TO_SHOW, MORE_ON_THE_RELEASES_PAGE, releaseNotesToBlocks, selectLatestReleases, selectReleasesToShow } from "@domain/appUpdate/whatsNew"

function release(overrides: Partial<WhatsNewReleaseInfo> = {}): WhatsNewReleaseInfo {
  return {
    tag: "1.0.0",
    name: "1.0.0",
    body: "",
    prerelease: false,
    draft: false,
    publishedAt: "2026-01-01T00:00:00Z",
    ...overrides
  }
}

function realReleaseBody(tag: string): string {
  return readFileSync(new URL(`../../fixtures/releaseNotes/${tag}.md`, import.meta.url), "utf8")
}

/** Compact spelling of an expected block sequence: "phh" is a paragraph then two headings. */
function kinds(blocks: readonly { kind: string }[]): string {
  return blocks.map((block) => block.kind[0]).join("")
}

/** Anything that would tell a reader the markdown reached the screen unreduced. */
const LEFTOVER_MARKUP = /!\[|\]\(|\*\*|^\||\|\s*-{2,}|<\/?[a-z]+>|&(?:amp|lt|gt|quot|#39);/

describe("releaseNotesToBlocks on the real release bodies", () => {
  it("reduces v1.7.0-beta.7 to its headings and paragraphs", () => {
    const blocks = releaseNotesToBlocks(realReleaseBody("v1.7.0-beta.7"))

    assert.equal(kinds(blocks), "phpphpphppphppppphppphpp")
    assert.equal(blocks.filter((block) => block.kind === "heading").length, 6)
    assert.equal(blocks.filter((block) => block.kind === "paragraph").length, 18)
    assert.deepEqual(
      blocks.filter((block) => block.kind === "heading").map((block) => block.text),
      ["Backups", "Installing a game version", "New", "Fixed", "Under the hood", "Known issues"]
    )
    // Inline code marks go, the identifiers they wrapped stay whole.
    assert.ok(blocks.some((block) => block.text.includes("so gamemoderun, mangohud or prime-run can front the game command")))
    assert.ok(blocks.some((block) => block.text.includes("the maintainer of riftlauncher-bin.")))
  })

  it("reduces v1.7.0-beta.8 to its headings and paragraphs", () => {
    const blocks = releaseNotesToBlocks(realReleaseBody("v1.7.0-beta.8"))

    assert.equal(kinds(blocks), "phpphphphpp")
    assert.equal(blocks.filter((block) => block.kind === "heading").length, 4)
    assert.equal(blocks.filter((block) => block.kind === "paragraph").length, 7)
    assert.equal(blocks[0]?.text.startsWith("A hotfix for beta.7, out the same day."), true)
    assert.equal(blocks.at(-1)?.text, "macOS still has no build.")
  })

  it("reduces v1.7.0-beta.9, table and screenshots included, to its headings and paragraphs", () => {
    const blocks = releaseNotesToBlocks(realReleaseBody("v1.7.0-beta.9"))

    assert.equal(kinds(blocks), "phpphppphpppppppphppppphpp")
    assert.equal(blocks.filter((block) => block.kind === "heading").length, 5)
    assert.equal(blocks.filter((block) => block.kind === "paragraph").length, 21)

    // The before/after table and the two screenshots in it leave nothing behind: the paragraph
    // introducing them is the last block of that section.
    const screenshots = blocks.findIndex((block) => block.text.startsWith("The screenshots below are the real components"))
    assert.ok(screenshots > 0)
    assert.deepEqual(blocks[screenshots + 1], { kind: "heading", text: "Reliability" })

    // A bold lead-in becomes the start of its own paragraph, markers and all gone.
    assert.ok(blocks.some((block) => block.text.startsWith("A missing .NET runtime is now named. A game version built against")))
    assert.ok(blocks.some((block) => block.text.includes("lands in error.log with a fixed-shape record")))
  })

  it("leaves no markdown or HTML syntax in any block of any real body", () => {
    for (const tag of ["v1.7.0-beta.7", "v1.7.0-beta.8", "v1.7.0-beta.9"]) {
      for (const block of releaseNotesToBlocks(realReleaseBody(tag))) {
        assert.ok(!LEFTOVER_MARKUP.test(block.text), `${tag}: ${block.text}`)
        assert.ok(block.text.length <= 2000)
      }
    }
  })
})

describe("releaseNotesToBlocks", () => {
  it("reads headings, bullets and paragraphs off ordinary markdown", () => {
    const markdown = ["# Highlights", "", "This release adds a thing.", "", "- Fixed a bug", "* Fixed another", "+ And a third", "", "## Notes ##", "A closing paragraph."].join("\n")

    assert.deepEqual(releaseNotesToBlocks(markdown), [
      { kind: "heading", text: "Highlights" },
      { kind: "paragraph", text: "This release adds a thing." },
      { kind: "bullet", text: "Fixed a bug" },
      { kind: "bullet", text: "Fixed another" },
      { kind: "bullet", text: "And a third" },
      { kind: "heading", text: "Notes" },
      { kind: "paragraph", text: "A closing paragraph." }
    ])
  })

  it("joins soft-wrapped lines of the same paragraph into one block", () => {
    const markdown = "This sentence\nkeeps going\nacross lines."
    assert.deepEqual(releaseNotesToBlocks(markdown), [{ kind: "paragraph", text: "This sentence keeps going across lines." }])
  })

  it("strips emphasis and inline code marks, keeping the text", () => {
    assert.deepEqual(releaseNotesToBlocks("This is **bold**, *italic*, `code` and ~~struck~~."), [{ kind: "paragraph", text: "This is bold, italic, code and struck." }])
  })

  it("closes a bold run that ends on a full stop", () => {
    assert.deepEqual(releaseNotesToBlocks("**Keyboard.** Escape closes it."), [{ kind: "paragraph", text: "Keyboard. Escape closes it." }])
  })

  it("leaves a marker that is inside a word or standing alone", () => {
    assert.deepEqual(releaseNotesToBlocks("snake_case and 5 * 3 and mesa_glthread and a<b"), [{ kind: "paragraph", text: "snake_case and 5 * 3 and mesa_glthread and a<b" }])
  })

  it("keeps an angle bracket that is not shaped like a tag", () => {
    assert.deepEqual(releaseNotesToBlocks("Anything under 5 < 10 > 3 stays, and 2 < 3 is still true."), [{ kind: "paragraph", text: "Anything under 5 < 10 > 3 stays, and 2 < 3 is still true." }])
  })

  it("keeps a link's text and drops its destination", () => {
    assert.deepEqual(releaseNotesToBlocks("See [the changelog](https://example.test/evil?x=1) for details."), [{ kind: "paragraph", text: "See the changelog for details." }])
  })

  it("drops an image whole, alt text included, in markdown and in HTML", () => {
    assert.deepEqual(releaseNotesToBlocks("Before ![a screenshot](https://example.test/x.png) after"), [{ kind: "paragraph", text: "Before after" }])
    assert.deepEqual(releaseNotesToBlocks('Before <img src="https://example.test/x.png" alt="a screenshot"> after'), [{ kind: "paragraph", text: "Before after" }])
  })

  it("drops a table, separator row written without a leading pipe included", () => {
    const markdown = ["Above the table.", "", "| Before | After |", "| --- | --- |", "| one | two |", "", "Below the table.", "", "Header | Header", "--- | ---", "a | b"].join("\n")

    // A table written with no leading pipe at all is not a table row by this rule; its separator
    // still goes, and what is left reads as the prose it looks like rather than as broken markup.
    assert.deepEqual(releaseNotesToBlocks(markdown), [
      { kind: "paragraph", text: "Above the table." },
      { kind: "paragraph", text: "Below the table." },
      { kind: "paragraph", text: "Header | Header" },
      { kind: "paragraph", text: "a | b" }
    ])
  })

  it("drops a fenced code block rather than flattening it into a paragraph", () => {
    const markdown = ["Run this:", "", "```sh", "rm -rf /tmp/cache", "echo done", "```", "", "Then restart."].join("\n")

    assert.deepEqual(releaseNotesToBlocks(markdown), [
      { kind: "paragraph", text: "Run this:" },
      { kind: "paragraph", text: "Then restart." }
    ])
  })

  it("turns an ordered list into bullets that keep their number", () => {
    assert.deepEqual(releaseNotesToBlocks("1. First\n2. Second\n3) Third"), [
      { kind: "bullet", text: "1. First" },
      { kind: "bullet", text: "2. Second" },
      { kind: "bullet", text: "3. Third" }
    ])
  })

  it("flattens a nested bullet onto the same level", () => {
    assert.deepEqual(releaseNotesToBlocks("- Outer\n  - Inner\n    - Deeper"), [
      { kind: "bullet", text: "Outer" },
      { kind: "bullet", text: "Inner" },
      { kind: "bullet", text: "Deeper" }
    ])
  })

  it("reads a setext heading, and drops a thematic break that underlines nothing", () => {
    assert.deepEqual(releaseNotesToBlocks("Big title\n=====\n\nSmaller title\n---\n\nBody.\n\n---\n\nAfter the break."), [
      { kind: "heading", text: "Big title" },
      { kind: "heading", text: "Smaller title" },
      { kind: "paragraph", text: "Body." },
      { kind: "paragraph", text: "After the break." }
    ])
  })

  it("decodes the five entities GitHub writes and nothing else", () => {
    assert.deepEqual(releaseNotesToBlocks("&amp; &lt; &gt; &quot; &#39; &nbsp; &copy;"), [{ kind: "paragraph", text: "& < > \" ' &nbsp; &copy;" }])
  })

  it("strips a plain HTML tag, an unterminated one, and an HTML comment", () => {
    assert.deepEqual(releaseNotesToBlocks("Before <b>bold</b> after <div>unterminated"), [{ kind: "paragraph", text: "Before bold after unterminated" }])
    assert.deepEqual(releaseNotesToBlocks("Before <!-- a comment --> after"), [{ kind: "paragraph", text: "Before after" }])
  })

  it("takes a comment spanning several blocks with it, closing marker included", () => {
    const markdown = ["Kept.", "", "<!-- reviewer note", "## A heading nobody should see", "- a bullet nobody should see", "-->", "", "Also kept."].join("\n")

    assert.deepEqual(releaseNotesToBlocks(markdown), [
      { kind: "paragraph", text: "Kept." },
      { kind: "paragraph", text: "Also kept." }
    ])
  })

  it("drops a script tag's whole body rather than turning it into text", () => {
    assert.deepEqual(releaseNotesToBlocks("Before <script>alert(document.cookie)</script> after"), [{ kind: "paragraph", text: "Before after" }])
  })

  it("does not hang on an unterminated comment or script, and drops everything after it", () => {
    assert.deepEqual(releaseNotesToBlocks("Before <!-- never closed"), [{ kind: "paragraph", text: "Before" }])
    assert.deepEqual(releaseNotesToBlocks("Before <script>never closed"), [{ kind: "paragraph", text: "Before" }])
  })

  it("collapses nested and repeated tags into nothing", () => {
    assert.deepEqual(releaseNotesToBlocks("<div><div><span>x</span></div></div>"), [{ kind: "paragraph", text: "x" }])
  })

  it("slices the input at 64 KiB, so nothing past it reaches a block", () => {
    const markdown = `# Kept\n\n${"filler ".repeat(12_000)}\n\nPAST-THE-CAP`

    assert.ok(markdown.length > 64 * 1024)
    const blocks = releaseNotesToBlocks(markdown)

    assert.deepEqual(blocks[0], { kind: "heading", text: "Kept" })
    assert.ok(blocks.every((block) => !block.text.includes("PAST-THE-CAP")))
  })

  it("truncates a long block at a word boundary with an ellipsis, heading as well as paragraph", () => {
    const long = "alpha ".repeat(400).trim()
    const blocks = releaseNotesToBlocks(`# ${long}\n\n${long}`)

    // 2000 characters would land inside the 334th "alpha", so the cut backs up to the space before it.
    const cut = `${"alpha ".repeat(333).trim()}${MORE_ON_THE_RELEASES_PAGE}`
    assert.deepEqual(blocks, [
      { kind: "heading", text: cut },
      { kind: "paragraph", text: cut }
    ])
    assert.ok(blocks.every((block) => block.text.length <= 2000))
  })

  it("cuts a long word with no space to back up to", () => {
    assert.deepEqual(releaseNotesToBlocks("x".repeat(3000)), [{ kind: "paragraph", text: `${"x".repeat(1999)}${MORE_ON_THE_RELEASES_PAGE}` }])
  })

  it("never truncates through the middle of a surrogate pair", () => {
    // The 2000th unit is a high surrogate, so the cut backs up one unit rather than splitting the pair.
    const text = releaseNotesToBlocks("😀".repeat(2000))[0]?.text ?? ""

    assert.equal(text, `${"😀".repeat(999)}${MORE_ON_THE_RELEASES_PAGE}`)
    assert.equal(text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "").search(/[\uD800-\uDFFF]/), -1)
  })

  it("caps the number of blocks and says the rest was left out", () => {
    const markdown = Array.from({ length: 200 }, (_, index) => `- item ${index}`).join("\n")
    const blocks = releaseNotesToBlocks(markdown)

    assert.equal(blocks.length, 120)
    assert.deepEqual(blocks.slice(0, 4), [
      { kind: "bullet", text: "item 0" },
      { kind: "bullet", text: "item 1" },
      { kind: "bullet", text: "item 2" },
      { kind: "bullet", text: "item 3" }
    ])
    assert.deepEqual(blocks.at(-2), { kind: "bullet", text: "item 118" })
    assert.deepEqual(blocks.at(-1), { kind: "paragraph", text: MORE_ON_THE_RELEASES_PAGE })
  })

  it("says nothing extra when the body fills the block cap exactly", () => {
    const blocks = releaseNotesToBlocks(Array.from({ length: 120 }, (_, index) => `- item ${index}`).join("\n"))

    assert.equal(blocks.length, 120)
    assert.deepEqual(blocks.at(-1), { kind: "bullet", text: "item 119" })
  })

  it("caps a huge body instead of processing all of it", () => {
    const huge = `# H\n${"word ".repeat(100_000)}`
    const blocks = releaseNotesToBlocks(huge)
    assert.ok(blocks.length <= 120)
    assert.ok(blocks.every((block) => block.text.length <= 2000))
  })

  it("returns nothing for anything that is not a string", () => {
    for (const value of [undefined, null, 42, {}, []]) assert.deepEqual(releaseNotesToBlocks(value), [])
    assert.deepEqual(releaseNotesToBlocks(""), [])
  })

  it("drops a heading or bullet that strips down to nothing", () => {
    assert.deepEqual(releaseNotesToBlocks("# <script>x</script>\n\n- <!-- gone -->"), [])
  })
})

describe("selectReleasesToShow", () => {
  it("keeps only the releases strictly after the previous version, up to and including the current one, newest first", () => {
    const releases = [release({ tag: "v1.2.0" }), release({ tag: "v1.1.0" }), release({ tag: "v1.0.0" }), release({ tag: "v0.9.0" })]

    assert.deepEqual(
      selectReleasesToShow(releases, "1.0.0", "1.2.0").map((r) => r.tag),
      ["v1.2.0", "v1.1.0"]
    )
  })

  it("never shows a release newer than the running version", () => {
    // The launcher can be behind its own repository: a newer tag is published while a player is
    // still on the previous build, and the notes for a version they are not running must not be
    // presented as what they just updated to.
    const releases = [release({ tag: "v1.3.0" }), release({ tag: "v1.2.0" }), release({ tag: "v1.1.0" })]

    assert.deepEqual(
      selectReleasesToShow(releases, "1.0.0", "1.2.0").map((r) => r.tag),
      ["v1.2.0", "v1.1.0"]
    )
  })

  it("tolerates a v prefix on either version and on a release's own tag", () => {
    const releases = [release({ tag: "1.1.0" })]
    assert.deepEqual(
      selectReleasesToShow(releases, "v1.0.0", "v1.1.0").map((r) => r.tag),
      ["1.1.0"]
    )
  })

  it("shows only the release equal to the current version when there is no previous one", () => {
    const releases = [release({ tag: "1.2.0" }), release({ tag: "1.1.0" }), release({ tag: "1.0.0" })]
    assert.deepEqual(
      selectReleasesToShow(releases, "", "1.1.0").map((r) => r.tag),
      ["1.1.0"]
    )
  })

  it("never shows a draft, previous version or not", () => {
    const releases = [release({ tag: "1.1.0", draft: true }), release({ tag: "1.0.5" })]
    assert.deepEqual(
      selectReleasesToShow(releases, "1.0.0", "1.1.0").map((r) => r.tag),
      ["1.0.5"]
    )
  })

  it("hides a prerelease from a stable running version", () => {
    const releases = [release({ tag: "1.1.0-beta.1", prerelease: true }), release({ tag: "1.0.5" })]
    assert.deepEqual(
      selectReleasesToShow(releases, "1.0.0", "1.1.0").map((r) => r.tag),
      ["1.0.5"]
    )
  })

  it("shows a prerelease when the running version is itself a prerelease", () => {
    const releases = [release({ tag: "1.1.0-beta.2", prerelease: true }), release({ tag: "1.1.0-beta.1", prerelease: true })]
    assert.deepEqual(
      selectReleasesToShow(releases, "1.1.0-beta.1", "1.1.0-beta.2").map((r) => r.tag),
      ["1.1.0-beta.2"]
    )
  })

  it("orders beta.10 after beta.9, not equal to it", () => {
    const releases = [release({ tag: "1.7.0-beta.10", prerelease: true }), release({ tag: "1.7.0-beta.9", prerelease: true })]
    assert.deepEqual(
      selectReleasesToShow(releases, "1.7.0-beta.9", "1.7.0-beta.10").map((r) => r.tag),
      ["1.7.0-beta.10"]
    )
  })

  it("ranks a plain release above every prerelease of the same version", () => {
    // The current version is itself a prerelease, so the prerelease-inclusion rule above lets
    // both entries through; what this pins is the tie-break between them once it does.
    const releases = [release({ tag: "1.6.5" }), release({ tag: "1.6.5-beta.1", prerelease: true })]
    assert.deepEqual(
      selectReleasesToShow(releases, "1.6.0", "1.7.0-beta.9").map((r) => r.tag),
      ["1.6.5", "1.6.5-beta.1"]
    )
  })

  it("sorts an oldest-first list newest first before the cap takes the five newest", () => {
    // GitHub answers newest first, so a list in the other order is what this guards against: cap
    // without sort would keep the five oldest, and every one of them would be wrong.
    const releases = Array.from({ length: 8 }, (_, index) => release({ tag: `1.${index + 1}.0` }))

    assert.deepEqual(
      selectReleasesToShow(releases, "1.0.0", "1.8.0").map((r) => r.tag),
      ["1.8.0", "1.7.0", "1.6.0", "1.5.0", "1.4.0"]
    )
    assert.equal(selectReleasesToShow(releases, "1.0.0", "1.8.0").length, DEFAULT_MAX_RELEASES_TO_SHOW)
  })

  it("shows nothing once the current version is already the last one seen", () => {
    assert.deepEqual(selectReleasesToShow([release({ tag: "1.0.0" })], "1.0.0", "1.0.0"), [])
  })

  it("leaves a tag semver refuses outside the window rather than guessing at its number", () => {
    // Nothing upstream constrains the shape of a tag: src/ipc/handlers/netHandlers.ts keeps any
    // non-empty tag_name of up to 128 characters, so `v1.8` can arrive. semver wants three parts
    // and refuses it, which ranks it below every tag semver does read, so it cannot fall between
    // two of them however large the number it opens with looks.
    const releases = [release({ tag: "v1.9.0" }), release({ tag: "v1.8" }), release({ tag: "v1.7.0" })]

    assert.deepEqual(
      selectReleasesToShow(releases, "1.7.0", "1.9.0").map((r) => r.tag),
      ["v1.9.0"]
    )
  })
})

describe("selectLatestReleases", () => {
  it("lists the newest releases first whatever the player has already seen", () => {
    const releases = [release({ tag: "1.1.0" }), release({ tag: "1.3.0" }), release({ tag: "1.2.0" })]

    assert.deepEqual(
      selectLatestReleases(releases, "1.3.0").map((r) => r.tag),
      ["1.3.0", "1.2.0", "1.1.0"]
    )
  })

  it("caps the list at five", () => {
    const releases = Array.from({ length: 8 }, (_, index) => release({ tag: `1.${index + 1}.0` }))

    assert.deepEqual(
      selectLatestReleases(releases, "1.8.0").map((r) => r.tag),
      ["1.8.0", "1.7.0", "1.6.0", "1.5.0", "1.4.0"]
    )
    assert.equal(selectLatestReleases(releases, "1.8.0").length, DEFAULT_MAX_RELEASES_TO_SHOW)
  })

  it("applies the same draft and prerelease rules the dialog does", () => {
    const releases = [release({ tag: "1.4.0", draft: true }), release({ tag: "1.3.0-beta.1", prerelease: true }), release({ tag: "1.2.0" })]

    assert.deepEqual(
      selectLatestReleases(releases, "1.2.0").map((r) => r.tag),
      ["1.2.0"]
    )
    assert.deepEqual(
      selectLatestReleases(releases, "1.3.0-beta.2").map((r) => r.tag),
      ["1.3.0-beta.1", "1.2.0"]
    )
  })

  it("still lists a release older than the running version, which is the whole point of it", () => {
    const releases = [release({ tag: "1.1.0" }), release({ tag: "1.0.0" })]

    assert.deepEqual(
      selectLatestReleases(releases, "1.1.0").map((r) => r.tag),
      ["1.1.0", "1.0.0"]
    )
  })

  it("lists every tag semver refuses last, in the same order on every render", () => {
    // Below the tags semver reads, and alphabetically among themselves, so a list holding more
    // than one of them does not shuffle between renders. Only letters here: two tags that sort
    // against each other through localeCompare, with no punctuation whose collation could differ
    // between the Linux and Windows runners.
    const releases = [release({ tag: "nightly" }), release({ tag: "alpha" }), release({ tag: "1.2.0" })]

    assert.deepEqual(
      selectLatestReleases(releases, "1.2.0").map((r) => r.tag),
      ["1.2.0", "nightly", "alpha"]
    )
    assert.deepEqual(
      selectLatestReleases([...releases].reverse(), "1.2.0").map((r) => r.tag),
      ["1.2.0", "nightly", "alpha"]
    )
  })
})
