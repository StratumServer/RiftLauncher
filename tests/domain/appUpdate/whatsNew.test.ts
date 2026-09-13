/**
 * releaseNotesToBlocks (a GitHub release body, treated as untrusted text, reduced to headings,
 * paragraphs and bullets) and selectReleasesToShow (which releases the "what's new" dialog and
 * the Info & Help section get to see at all), src/domain/appUpdate/whatsNew.ts.
 */
import assert from "node:assert/strict"
import { describe, it } from "vitest"

import { DEFAULT_MAX_RELEASES_TO_SHOW, releaseNotesToBlocks, selectReleasesToShow } from "@domain/appUpdate/whatsNew"

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

describe("releaseNotesToBlocks", () => {
  it("reads headings, bullets and paragraphs off ordinary markdown", () => {
    const markdown = ["# Highlights", "", "This release adds a thing.", "", "- Fixed a bug", "* Fixed another", "+ And a third", "", "## Notes", "A closing paragraph."].join("\n")

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
    assert.deepEqual(releaseNotesToBlocks("This is **bold**, *italic* and `code`."), [{ kind: "paragraph", text: "This is bold, italic and code." }])
  })

  it("keeps a link's text and drops its destination", () => {
    assert.deepEqual(releaseNotesToBlocks("See [the changelog](https://example.test/evil?x=1) for details."), [{ kind: "paragraph", text: "See the changelog for details." }])
  })

  it("strips a plain HTML tag, an unterminated one, and an HTML comment", () => {
    assert.deepEqual(releaseNotesToBlocks("Before <b>bold</b> after <div>unterminated"), [{ kind: "paragraph", text: "Before bold after unterminated" }])
    assert.deepEqual(releaseNotesToBlocks("Before <!-- a comment --> after"), [{ kind: "paragraph", text: "Before after" }])
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

  it("caps a huge body instead of processing all of it", () => {
    const huge = `# H\n${"word ".repeat(100_000)}`
    const blocks = releaseNotesToBlocks(huge)
    assert.ok(blocks.length <= 40)
    assert.ok(blocks.every((block) => block.text.length <= 600))
  })

  it("caps the number of blocks and the length of each to the given limits", () => {
    const markdown = Array.from({ length: 10 }, (_, index) => `- item ${index}`).join("\n")
    const blocks = releaseNotesToBlocks(markdown, { maxBlocks: 3, maxBlockLength: 5 })
    assert.equal(blocks.length, 3)
    assert.ok(blocks.every((block) => block.text.length <= 5))
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

  it("caps the result to 5 releases by default, and to a given override", () => {
    const releases = Array.from({ length: 8 }, (_, index) => release({ tag: `1.${index + 1}.0` }))

    assert.equal(selectReleasesToShow(releases, "1.0.0", "1.8.0").length, DEFAULT_MAX_RELEASES_TO_SHOW)
    assert.equal(selectReleasesToShow(releases, "1.0.0", "1.8.0", { maxReleases: 2 }).length, 2)
  })

  it("shows nothing once the current version is already the last one seen", () => {
    assert.deepEqual(selectReleasesToShow([release({ tag: "1.0.0" })], "1.0.0", "1.0.0"), [])
  })
})
