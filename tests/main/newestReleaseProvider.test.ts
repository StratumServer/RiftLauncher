import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire, Module } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, it } from "vitest"

import type { AppUpdater, UpdateInfo } from "electron-updater"

import { githubFeedFromAppUpdateYml, newestReleaseProvider, tagsFromReleasesFeed, updateCandidateTags, installNewestReleaseProvider } from "@src/main/newestReleaseProvider"

/**
 * Which release the launcher's updater offers, against the real electron-updater.
 *
 * The selection rule lives inside electron-updater's provider, so the only honest way to test it
 * is to let the package run: a real NsisUpdater (the Linux rows only change the platform it reports),
 * the real GitHubProvider underneath ours, and a fake HTTP executor in place of the network that
 * answers the three kinds of request a GitHub feed gets: the releases.atom feed, the
 * `releases/latest` redirect target, and `releases/download/<tag>/<metadata file>`.
 */

const OWNER = "StratumServer"
const REPO = "RiftLauncher"
const RELEASES = `/${OWNER}/${REPO}/releases`
const APP_UPDATE_YML = `owner: ${OWNER}\nrepo: ${REPO}\nprovider: github\nupdaterCacheDirName: riftlauncher-updater\n`

type ElectronUpdater = typeof import("electron-updater")
type AppAdapter = NonNullable<ConstructorParameters<ElectronUpdater["NsisUpdater"]>[1]>
type Platform = "win32" | "linux"

interface FakeFeed {
  /** Tags in releases.atom, newest first as GitHub lists them. */
  atom: string[]
  /** What `releases/latest` answers, or undefined for a repository with no regular release (a 404). */
  latest?: string
  /** Tags with a published metadata file. Every other tag is a bare git tag or a draft: its metadata is a 404. */
  published: string[]
  /** Tags whose metadata request fails with this status instead. */
  failing?: Record<string, number>
}

let electronUpdater: ElectronUpdater
let forgetElectronStub: (() => void) | undefined
let temporaryRoot: string

beforeAll(async () => {
  // electron-updater requires `electron` while it loads and there is no Electron process here.
  const requireFromHere = createRequire(__filename)
  const electronPath = requireFromHere.resolve("electron")
  const electronStub = new Module(electronPath)
  electronStub.filename = electronPath
  electronStub.loaded = true
  electronStub.exports = { app: {} }
  requireFromHere.cache[electronPath] = electronStub
  forgetElectronStub = (): void => {
    delete requireFromHere.cache[electronPath]
  }

  electronUpdater = await import("electron-updater")
})

afterAll(() => {
  forgetElectronStub?.()
})

beforeEach(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "newest-release-provider-"))
  mkdirSync(join(temporaryRoot, "resources"), { recursive: true })
  writeFileSync(join(temporaryRoot, "resources", "app-update.yml"), APP_UPDATE_YML)
})

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
})

function atomXml(tags: readonly string[]): string {
  const entries = tags.map(
    (tag) =>
      `<entry><id>tag:github.com,2008:Repository/1/${tag}</id><link rel="alternate" type="text/html" href="https://github.com/${OWNER}/${REPO}/releases/tag/${tag}"/><title>${tag}</title><content type="html">notes</content></entry>`
  )
  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom"><link type="text/html" rel="alternate" href="https://github.com/${OWNER}/${REPO}/releases"/>${entries.join("")}</feed>`
}

function metadataYml(tag: string, platform: Platform): string {
  const version = tag.replace(/^v/, "")
  const file = platform === "linux" ? `riftlauncher-${version}.AppImage` : `riftlauncher-${version}-setup.exe`
  const sha512 = `${"A".repeat(86)}==`
  return `version: ${version}\nfiles:\n  - url: ${file}\n    sha512: ${sha512}\n    size: 1000\npath: ${file}\nsha512: ${sha512}\nreleaseDate: '2026-10-22T10:00:00.000Z'\n`
}

function httpError(statusCode: number): Error {
  return Object.assign(new Error(`HTTP ${statusCode}`), { statusCode })
}

/** The network: answers by path, records every path asked. */
function fakeExecutor(feed: FakeFeed, platform: Platform, requests: string[]): unknown {
  const channelFile = platform === "linux" ? "latest-linux.yml" : "latest.yml"
  return {
    request: (options: { path?: string }): Promise<string> => {
      const path = options.path ?? ""
      requests.push(path)
      if (path === `${RELEASES}.atom`) return Promise.resolve(atomXml(feed.atom))
      if (path === `${RELEASES}/latest`) {
        return feed.latest === undefined ? Promise.reject(httpError(404)) : Promise.resolve(JSON.stringify({ tag_name: feed.latest }))
      }
      const download = new RegExp(`^${RELEASES}/download/([^/]+)/${channelFile}$`).exec(path)
      if (download) {
        const tag = download[1] ?? ""
        const failure = feed.failing?.[tag]
        if (failure) return Promise.reject(httpError(failure))
        return feed.published.includes(tag) ? Promise.resolve(metadataYml(tag, platform)) : Promise.reject(httpError(404))
      }
      return Promise.reject(httpError(404))
    }
  }
}

function newUpdater(running: string, platform: Platform, executor: unknown): AppUpdater {
  const app: AppAdapter = {
    version: running,
    name: "RiftLauncher",
    isPackaged: true,
    appUpdateConfigPath: join(temporaryRoot, "app-update.yml"),
    userDataPath: join(temporaryRoot, "userData"),
    baseCachePath: join(temporaryRoot, "cache"),
    whenReady: () => Promise.resolve(),
    relaunch: (): void => {},
    quit: (): void => {},
    onQuit: (): void => {}
  }
  const updater = new electronUpdater.NsisUpdater(undefined, app)
  updater.autoDownload = false
  ;(updater as unknown as { httpExecutor: unknown }).httpExecutor = executor
  ;(updater as unknown as { _testOnlyOptions: { platform: Platform } })._testOnlyOptions = { platform }
  return updater
}

interface CheckOutcome {
  offered: string | null
  error: string | null
  requests: string[]
  updater: AppUpdater
}

/** One update check, wired exactly as main/index.ts wires it: the provider from resources/app-update.yml, then the check. */
async function check(running: string, allowPrerelease: boolean, feed: FakeFeed, platform: Platform = "win32"): Promise<CheckOutcome> {
  const requests: string[] = []
  const updater = newUpdater(running, platform, fakeExecutor(feed, platform, requests))
  assert.equal(await installNewestReleaseProvider(updater, join(temporaryRoot, "resources")), true)
  updater.allowPrerelease = allowPrerelease
  try {
    const result = await updater.checkForUpdates()
    return { offered: result?.isUpdateAvailable ? result.updateInfo.version : null, error: null, requests, updater }
  } catch (error) {
    return { offered: null, error: error instanceof Error ? error.message : String(error), requests, updater }
  }
}

describe("updateCandidateTags", () => {
  const cases: Array<{ name: string; tags: string[]; running: string; expected: string[] }> = [
    {
      name: "a beta is offered the rc after it, and keeps its own tag as the fallback",
      tags: ["v1.7.0-rc.1", "v1.7.0-beta.14", "v1.7.0-beta.13"],
      running: "1.7.0-beta.14",
      expected: ["v1.7.0-rc.1", "v1.7.0-beta.14"]
    },
    { name: "the stable release sorts above every rc of its version", tags: ["v1.7.0-rc.2", "v1.7.0", "v1.7.0-rc.1"], running: "1.7.0-rc.1", expected: ["v1.7.0", "v1.7.0-rc.2", "v1.7.0-rc.1"] },
    { name: "the order of the feed does not decide, the version does", tags: ["v1.7.0-beta.15", "v1.8.0-beta.1", "v1.7.0"], running: "1.7.0", expected: ["v1.8.0-beta.1", "v1.7.0"] },
    {
      name: "alpha < beta < rc < stable",
      tags: ["v2.0.0", "v2.0.0-rc.1", "v2.0.0-beta.1", "v2.0.0-alpha.1"],
      running: "2.0.0-alpha.1",
      expected: ["v2.0.0", "v2.0.0-rc.1", "v2.0.0-beta.1", "v2.0.0-alpha.1"]
    },
    { name: "numeric identifiers compare as numbers: beta.10 is above beta.9", tags: ["v1.7.0-beta.9", "v1.7.0-beta.10"], running: "1.7.0-beta.9", expected: ["v1.7.0-beta.10", "v1.7.0-beta.9"] },
    { name: "an older version is dropped, so there is no downgrade", tags: ["v1.6.0", "v1.7.0-beta.3", "v1.7.0-rc.1"], running: "1.7.0-rc.1", expected: ["v1.7.0-rc.1"] },
    { name: "tags that are not semver are dropped", tags: ["latest", "docs-2024", "1.8", "v1.8.0"], running: "1.7.0", expected: ["v1.8.0"] },
    { name: "an unknown prerelease identifier is dropped", tags: ["v1.8.0-nightly.1", "v1.8.0-0", "v1.8.0-rc.1"], running: "1.7.0", expected: ["v1.8.0-rc.1"] },
    { name: "tags with and without the v prefix both count", tags: ["1.8.0-rc.1", "v1.8.0-rc.2"], running: "1.7.0", expected: ["v1.8.0-rc.2", "1.8.0-rc.1"] },
    { name: "the running version may be missing from the feed", tags: ["v1.8.0"], running: "1.7.0", expected: ["v1.8.0"] },
    { name: "an empty feed has no candidate", tags: [], running: "1.7.0", expected: [] }
  ]

  for (const { name, tags, running, expected } of cases) {
    it(name, () => {
      assert.deepEqual(updateCandidateTags(tags, running), expected)
    })
  }
})

describe("tagsFromReleasesFeed", () => {
  it("reads the tags of a feed that holds a bare tag, and skips the feed's own link to /releases", () => {
    const tags = ["v1.7.2", "v1.7.1", "v1.7.0-beta.14", "v1.7.0", "v1.7.0-beta.13"]

    assert.deepEqual(tagsFromReleasesFeed(atomXml(tags)), tags)
  })

  it("decodes percent escapes in a tag", () => {
    assert.deepEqual(tagsFromReleasesFeed(atomXml(["v1.8.0%2Bbuild"])), ["v1.8.0+build"])
  })

  it("returns nothing for an empty or unreadable feed", () => {
    assert.deepEqual(tagsFromReleasesFeed(""), [])
    assert.deepEqual(tagsFromReleasesFeed("<html>rate limited</html>"), [])
  })
})

describe("githubFeedFromAppUpdateYml", () => {
  it("reads the file electron-builder generates", () => {
    assert.deepEqual(githubFeedFromAppUpdateYml(APP_UPDATE_YML), { owner: "StratumServer", repo: "RiftLauncher" })
  })

  it("follows a retargeted feed", () => {
    assert.deepEqual(githubFeedFromAppUpdateYml("owner: StratumServer\nrepo: riftlauncher-update-test\nprovider: github\n"), { owner: "StratumServer", repo: "riftlauncher-update-test" })
  })

  it("keeps the host and the protocol of a feed that is not github.com", () => {
    assert.deepEqual(githubFeedFromAppUpdateYml("owner: o\nrepo: r\nprovider: github\nhost: ghe.example.com:8443\nprotocol: http\n"), {
      owner: "o",
      repo: "r",
      host: "ghe.example.com:8443",
      protocol: "http"
    })
    assert.deepEqual(githubFeedFromAppUpdateYml("owner: o\nrepo: r\nprovider: github\nhost: ghe.example.com\n"), { owner: "o", repo: "r", host: "ghe.example.com" })
  })

  it("gives up on a host or a protocol it cannot read, since dropping it would point the feed at github.com", () => {
    assert.equal(githubFeedFromAppUpdateYml("owner: o\nrepo: r\nprovider: github\nhost: 'ghe.example.com'\n"), null)
    assert.equal(githubFeedFromAppUpdateYml("owner: o\nrepo: r\nprovider: github\nprotocol: ftp\n"), null)
  })

  it("gives up on anything that is not a plain GitHub feed", () => {
    assert.equal(githubFeedFromAppUpdateYml("provider: generic\nurl: https://example.com/updates\n"), null)
    assert.equal(githubFeedFromAppUpdateYml("owner: StratumServer\nprovider: github\n"), null)
    assert.equal(githubFeedFromAppUpdateYml("owner: 'StratumServer'\nrepo: RiftLauncher\nprovider: github\n"), null)
    assert.equal(githubFeedFromAppUpdateYml("owner: StratumServer\nrepo: RiftLauncher\nprovider: generic\n"), null)
    assert.equal(githubFeedFromAppUpdateYml(""), null)
  })
})

describe("the release the updater offers", () => {
  const everything = (atom: string[]): FakeFeed => ({ atom, published: atom })

  const rows: Array<{ name: string; running: string; prerelease: boolean; feed: FakeFeed; offered: string | null }> = [
    { name: "beta to rc", running: "1.7.0-beta.14", prerelease: true, feed: everything(["v1.7.0-rc.1", "v1.7.0-beta.14", "v1.7.0-beta.13"]), offered: "1.7.0-rc.1" },
    { name: "rc to the next rc", running: "1.7.0-rc.1", prerelease: true, feed: everything(["v1.7.0-rc.2", "v1.7.0-rc.1"]), offered: "1.7.0-rc.2" },
    {
      name: "rc to the stable release, though the stable one is not the newest tag in the feed",
      running: "1.7.0-rc.1",
      prerelease: true,
      feed: everything(["v1.7.0-rc.2", "v1.7.0", "v1.7.0-rc.1"]),
      offered: "1.7.0"
    },
    { name: "the last rc to the stable release", running: "1.7.0-rc.2", prerelease: true, feed: everything(["v1.7.0", "v1.7.0-rc.2"]), offered: "1.7.0" },
    { name: "beta.9 to beta.10", running: "1.7.0-beta.9", prerelease: true, feed: everything(["v1.7.0-beta.10", "v1.7.0-beta.9"]), offered: "1.7.0-beta.10" },
    { name: "alpha to beta", running: "1.8.0-alpha.1", prerelease: true, feed: everything(["v1.8.0-beta.1", "v1.8.0-alpha.1"]), offered: "1.8.0-beta.1" },
    { name: "a stable build with Beta versions on is offered the next rc", running: "1.7.0", prerelease: true, feed: everything(["v1.8.0-rc.1", "v1.7.0"]), offered: "1.8.0-rc.1" },
    {
      name: "a stable build with Beta versions on is offered the newest of the next version's prereleases",
      running: "1.7.0",
      prerelease: true,
      feed: everything(["v1.8.0-beta.2", "v1.8.0-rc.1", "v1.8.0-beta.1", "v1.7.0"]),
      offered: "1.8.0-rc.1"
    },
    {
      name: "an older beta listed before the next version's first beta does not hide it",
      running: "1.7.0",
      prerelease: true,
      feed: everything(["v1.7.0-beta.15", "v1.8.0-beta.1", "v1.7.0"]),
      offered: "1.8.0-beta.1"
    },
    {
      name: "a bare tag above everything is skipped, not a failed check",
      running: "1.7.0",
      prerelease: true,
      feed: { atom: ["v1.7.1", "v1.8.0-rc.1", "v1.7.0"], published: ["v1.8.0-rc.1", "v1.7.0"] },
      offered: "1.8.0-rc.1"
    },
    {
      name: "a bare tag between two real ones is skipped",
      running: "1.7.0-beta.14",
      prerelease: true,
      feed: { atom: ["v1.7.0-rc.2", "v1.7.0-rc.1", "v1.7.0-beta.14"], published: ["v1.7.0-rc.1", "v1.7.0-beta.14"] },
      offered: "1.7.0-rc.1"
    },
    { name: "up to date on the newest rc", running: "1.7.0-rc.2", prerelease: true, feed: everything(["v1.7.0-rc.2", "v1.7.0-rc.1"]), offered: null },
    {
      name: "every newer tag is bare: nothing to offer, and no error",
      running: "1.7.0-rc.1",
      prerelease: true,
      feed: { atom: ["v1.7.0", "v1.7.0-rc.2", "v1.7.0-rc.1"], published: ["v1.7.0-rc.1"] },
      offered: null
    },
    {
      name: "a beta build newer than every tag in the feed: nothing to offer, and no error",
      running: "1.7.0-beta.15",
      prerelease: true,
      feed: everything(["v1.7.0-beta.14", "v1.7.0-beta.13"]),
      offered: null
    },
    { name: "a stable build newer than every tag in the feed: nothing to offer, and no error", running: "1.8.0", prerelease: true, feed: everything(["v1.7.0", "v1.7.0-rc.1"]), offered: null },
    {
      name: "an rc build newer than every tag, with no rc in the feed yet: nothing to offer, and no error",
      running: "1.7.0-rc.1",
      prerelease: true,
      feed: everything(["v1.7.0-beta.14", "v1.6.0"]),
      offered: null
    },
    {
      name: "a build newer than every tag skips a bare tag at the head of the feed",
      running: "1.7.0-beta.15",
      prerelease: true,
      feed: { atom: ["v1.7.0-beta.14", "v1.7.0-beta.13"], published: ["v1.7.0-beta.13"] },
      offered: null
    },
    {
      name: "a build newer than every known tag is not offered a tag with an unknown channel",
      running: "1.7.1",
      prerelease: true,
      feed: everything(["v1.8.0-nightly.1", "v1.8.0-0", "v1.7.0"]),
      offered: null
    },
    { name: "no downgrade from an rc to the beta it followed", running: "1.7.0-rc.1", prerelease: true, feed: everything(["v1.7.0-rc.1", "v1.7.0-beta.14"]), offered: null },
    { name: "no downgrade from a stable build to an older release", running: "1.7.0", prerelease: true, feed: everything(["v1.7.0", "v1.6.0", "v1.7.0-rc.1"]), offered: null },
    { name: "a tag with an unknown channel is not offered", running: "1.7.0", prerelease: true, feed: everything(["v1.8.0-nightly.1", "v1.7.0"]), offered: null },
    {
      name: "Beta versions off on an rc build: the latest regular release, through GitHub's own pick",
      running: "1.7.0-rc.2",
      prerelease: false,
      feed: { ...everything(["v1.7.0", "v1.7.0-rc.2"]), latest: "v1.7.0" },
      offered: "1.7.0"
    },
    {
      name: "Beta versions off on a stable build: a newer rc is not offered",
      running: "1.7.0",
      prerelease: false,
      feed: { ...everything(["v1.8.0-rc.1", "v1.7.0"]), latest: "v1.7.0" },
      offered: null
    },
    {
      name: "Beta versions off on a beta build: no downgrade to the older stable release",
      running: "1.7.0-beta.14",
      prerelease: false,
      feed: { ...everything(["v1.7.0-rc.1", "v1.7.0-beta.14", "v1.6.0"]), latest: "v1.6.0" },
      offered: null
    }
  ]

  for (const { name, running, prerelease, feed, offered } of rows) {
    it(`${name} (running ${running}, prereleases ${prerelease ? "allowed" : "off"})`, async () => {
      const outcome = await check(running, prerelease, feed)

      assert.equal(outcome.error, null)
      assert.equal(outcome.offered, offered)
    })
  }

  it("fails when no tag at all carries metadata, since the running version has nothing to compare with", async () => {
    const outcome = await check("1.7.0-rc.1", true, { atom: ["v1.7.0-rc.2"], published: [] })

    assert.match(outcome.error ?? "", /No release from 1\.7\.0-rc\.1 on carries latest\.yml/)
  })

  it("fails the check on an error that is not a missing file, instead of skipping the release", async () => {
    const outcome = await check("1.7.0-rc.1", true, { atom: ["v1.7.0", "v1.7.0-rc.1"], published: ["v1.7.0", "v1.7.0-rc.1"], failing: { "v1.7.0": 500 } })

    assert.equal(outcome.offered, null)
    assert.match(outcome.error ?? "", /HTTP 500/)
  })

  it("asks for the metadata of the tags newest first and stops at the first one that has it", async () => {
    const outcome = await check("1.7.0", true, { atom: ["v1.7.1", "v1.8.0-rc.1", "v1.7.0"], published: ["v1.8.0-rc.1", "v1.7.0"] })

    assert.deepEqual(
      outcome.requests.filter((path) => path.includes("/download/")),
      [`${RELEASES}/download/v1.8.0-rc.1/latest.yml`]
    )
  })

  it("never looks at a release older than the running version", async () => {
    const outcome = await check("1.7.0-rc.1", true, { atom: ["v1.7.0-rc.2", "v1.7.0-rc.1", "v1.7.0-beta.14"], published: ["v1.7.0-beta.14"] })

    assert.equal(outcome.offered, null)
    assert.deepEqual(
      outcome.requests.filter((path) => path.includes("/download/")),
      [`${RELEASES}/download/v1.7.0-rc.2/latest.yml`, `${RELEASES}/download/v1.7.0-rc.1/latest.yml`]
    )
  })

  it("asks for the bare tag too, and only for it, before skipping it", async () => {
    const outcome = await check("1.7.0", true, { atom: ["v1.9.0", "v1.8.0-rc.1", "v1.7.0"], published: ["v1.8.0-rc.1", "v1.7.0"] })

    assert.deepEqual(
      outcome.requests.filter((path) => path.includes("/download/")),
      [`${RELEASES}/download/v1.9.0/latest.yml`, `${RELEASES}/download/v1.8.0-rc.1/latest.yml`]
    )
  })

  it("with prereleases off runs the stock path: GitHub's latest release, and the metadata of that one tag only", async () => {
    const outcome = await check("1.7.0-rc.2", false, { atom: ["v1.7.0", "v1.7.0-rc.2"], published: ["v1.7.0", "v1.7.0-rc.2"], latest: "v1.7.0" })

    assert.ok(outcome.requests.includes(`${RELEASES}/latest`))
    assert.deepEqual(
      outcome.requests.filter((path) => path.includes("/download/")),
      [`${RELEASES}/download/v1.7.0/latest.yml`]
    )
  })

  it("on Linux reads latest-linux.yml and resolves the AppImage", async () => {
    const outcome = await check("1.7.0-beta.14", true, { atom: ["v1.7.0-rc.1", "v1.7.0-beta.14"], published: ["v1.7.0-rc.1", "v1.7.0-beta.14"] }, "linux")

    assert.equal(outcome.offered, "1.7.0-rc.1")
    assert.ok(outcome.requests.includes(`${RELEASES}/download/v1.7.0-rc.1/latest-linux.yml`))
  })

  it("tells the updater the check found nothing, rather than raising an error event, when it is up to date", async () => {
    const requests: string[] = []
    const updater = newUpdater("1.7.0-rc.2", "win32", fakeExecutor(everything(["v1.7.0-rc.2"]), "win32", requests))
    const events: string[] = []
    updater.on("update-not-available", () => events.push("update-not-available"))
    updater.on("error", () => events.push("error"))
    await installNewestReleaseProvider(updater, join(temporaryRoot, "resources"))
    updater.allowPrerelease = true

    await updater.checkForUpdates()

    assert.deepEqual(events, ["update-not-available"])
  })
})

describe("the download of an offered release", () => {
  /** The provider class itself, built the way installNewestReleaseProvider builds it. */
  async function providerFor(running: string, platform: Platform = "win32"): Promise<{ provider: InstanceType<ReturnType<typeof newestReleaseProvider>>; updater: AppUpdater }> {
    const { GitHubProvider } = await import("electron-updater/out/providers/GitHubProvider.js")
    const { parseUpdateInfo } = await import("electron-updater/out/providers/Provider.js")
    const executor = fakeExecutor({ atom: [], published: [] }, platform, [])
    const updater = newUpdater(running, platform, executor)
    const Provider = newestReleaseProvider(GitHubProvider, parseUpdateInfo, { owner: OWNER, repo: REPO })
    return { provider: new Provider({}, updater, { executor, platform, isUseMultipleRangeRequest: true } as never), updater }
  }

  it("downloads from the offered tag's own release", async () => {
    const { provider } = await providerFor("1.7.0-rc.1")
    const info = {
      tag: "v1.7.0-rc.2",
      version: "1.7.0-rc.2",
      files: [{ url: "riftlauncher-1.7.0-rc.2-setup.exe", sha512: "x", size: 1 }],
      path: "riftlauncher-1.7.0-rc.2-setup.exe",
      sha512: "x",
      releaseDate: ""
    } as UpdateInfo & { tag: string }

    assert.deepEqual(
      provider.resolveFiles(info).map((file) => file.url.href),
      [`https://github.com${RELEASES}/download/v1.7.0-rc.2/riftlauncher-1.7.0-rc.2-setup.exe`]
    )
  })

  it("keeps the differential download: the old blockmap is the running version's own, and ranges are asked one at a time", async () => {
    const { provider } = await providerFor("1.7.0-rc.1")
    const url = new URL(`https://github.com${RELEASES}/download/v1.7.0-rc.2/riftlauncher-1.7.0-rc.2-setup.exe`)

    const [oldBlockMap, newBlockMap] = await provider.getBlockMapFiles(url, "1.7.0-rc.1", "1.7.0-rc.2")

    assert.equal(oldBlockMap?.href, `https://github.com${RELEASES}/download/v1.7.0-rc.1/riftlauncher-1.7.0-rc.1-setup.exe.blockmap`)
    assert.equal(newBlockMap?.href, `${url.href}.blockmap`)
    assert.equal(provider.isUseMultipleRangeRequest, false)
  })

  it("keeps it from a beta to an rc and from an rc to the stable release", async () => {
    const { provider } = await providerFor("1.7.0-beta.14")

    const beta = await provider.getBlockMapFiles(new URL(`https://github.com${RELEASES}/download/v1.7.0-rc.1/riftlauncher-1.7.0-rc.1-setup.exe`), "1.7.0-beta.14", "1.7.0-rc.1")
    const stable = await provider.getBlockMapFiles(new URL(`https://github.com${RELEASES}/download/v1.7.0/riftlauncher-1.7.0-setup.exe`), "1.7.0-rc.2", "1.7.0")

    assert.equal(beta[0]?.pathname, `${RELEASES}/download/v1.7.0-beta.14/riftlauncher-1.7.0-beta.14-setup.exe.blockmap`)
    assert.equal(stable[0]?.pathname, `${RELEASES}/download/v1.7.0-rc.2/riftlauncher-1.7.0-rc.2-setup.exe.blockmap`)
  })

  it("on Linux resolves the AppImage, whose blockmap is embedded", async () => {
    const { provider } = await providerFor("1.7.0-rc.1", "linux")
    const info = {
      tag: "v1.7.0",
      version: "1.7.0",
      files: [{ url: "riftlauncher-1.7.0.AppImage", sha512: "x", size: 1 }],
      path: "riftlauncher-1.7.0.AppImage",
      sha512: "x",
      releaseDate: ""
    } as UpdateInfo & { tag: string }

    assert.deepEqual(
      provider.resolveFiles(info).map((file) => file.url.href),
      [`https://github.com${RELEASES}/download/v1.7.0/riftlauncher-1.7.0.AppImage`]
    )
    assert.equal(provider.isUseMultipleRangeRequest, false)
  })
})

describe("installNewestReleaseProvider", () => {
  function recordingUpdater(): { updater: AppUpdater; feeds: unknown[] } {
    const updater = newUpdater("1.7.0-beta.14", "win32", fakeExecutor({ atom: [], published: [] }, "win32", []))
    const feeds: unknown[] = []
    updater.setFeedURL = (options): void => {
      feeds.push(options)
    }
    return { updater, feeds }
  }

  it("plugs a custom provider into the updater when app-update.yml names a GitHub feed", async () => {
    const { updater, feeds } = recordingUpdater()

    assert.equal(await installNewestReleaseProvider(updater, join(temporaryRoot, "resources")), true)

    assert.equal(feeds.length, 1)
    assert.equal((feeds[0] as { provider: string }).provider, "custom")
    assert.equal(typeof (feeds[0] as { updateProvider: unknown }).updateProvider, "function")
  })

  it("leaves the stock provider alone when app-update.yml is not a GitHub feed", async () => {
    writeFileSync(join(temporaryRoot, "resources", "app-update.yml"), "provider: generic\nurl: https://example.com/updates\n")
    const { updater, feeds } = recordingUpdater()

    assert.equal(await installNewestReleaseProvider(updater, join(temporaryRoot, "resources")), false)
    assert.deepEqual(feeds, [])
  })

  it("lets the caller see that app-update.yml is missing", async () => {
    const { updater, feeds } = recordingUpdater()

    await assert.rejects(installNewestReleaseProvider(updater, join(temporaryRoot, "nowhere")), /ENOENT/)
    assert.deepEqual(feeds, [])
  })

  it("follows a retargeted feed, never a hardcoded repository", async () => {
    writeFileSync(join(temporaryRoot, "resources", "app-update.yml"), "owner: StratumServer\nrepo: riftlauncher-update-test\nprovider: github\n")
    const requests: string[] = []
    const updater = newUpdater("1.7.0-beta.14", "win32", {
      request: (options: { path?: string }): Promise<string> => {
        requests.push(options.path ?? "")
        return Promise.reject(Object.assign(new Error("HTTP 404"), { statusCode: 404 }))
      }
    })
    await installNewestReleaseProvider(updater, join(temporaryRoot, "resources"))
    updater.allowPrerelease = true

    await updater.checkForUpdates().catch(() => undefined)

    assert.deepEqual(requests, ["/StratumServer/riftlauncher-update-test/releases.atom"])
  })

  describe("with a feed on another host", () => {
    const HOST_YML = `owner: ${OWNER}\nrepo: ${REPO}\nprovider: github\nhost: ghe.example.com:8443\nprotocol: http\n`

    /** Every request as `protocol//host:port/path`, answered as the usual fake feed, with the enterprise API path mapped back to the plain one. */
    async function checkOnHost(running: string, allowPrerelease: boolean, feed: FakeFeed): Promise<string[]> {
      writeFileSync(join(temporaryRoot, "resources", "app-update.yml"), HOST_YML)
      const seen: string[] = []
      const inner = fakeExecutor(feed, "win32", []) as { request: (options: { path?: string }) => Promise<string> }
      const updater = newUpdater(running, "win32", {
        request: (options: { protocol?: string; hostname?: string; port?: string; path?: string }): Promise<string> => {
          seen.push(`${options.protocol}//${options.hostname}${options.port ? `:${options.port}` : ""}${options.path}`)
          return inner.request({ ...options, path: (options.path ?? "").replace(`/api/v3/repos/${OWNER}/${REPO}/releases/latest`, `${RELEASES}/latest`) })
        }
      })
      await installNewestReleaseProvider(updater, join(temporaryRoot, "resources"))
      updater.allowPrerelease = allowPrerelease
      await updater.checkForUpdates()
      return seen
    }

    it("asks that host for the atom feed and the metadata when prereleases are allowed", async () => {
      const seen = await checkOnHost("1.7.0-beta.14", true, { atom: ["v1.7.0-rc.1", "v1.7.0-beta.14"], published: ["v1.7.0-rc.1", "v1.7.0-beta.14"] })

      assert.deepEqual(seen, [`http://ghe.example.com:8443${RELEASES}.atom`, `http://ghe.example.com:8443${RELEASES}/download/v1.7.0-rc.1/latest.yml`])
    })

    it("asks that host's API for the latest release, then its metadata, when prereleases are off", async () => {
      const seen = await checkOnHost("1.7.0-rc.2", false, { atom: ["v1.7.0"], published: ["v1.7.0"], latest: "v1.7.0" })

      assert.deepEqual(seen, [
        `http://ghe.example.com:8443${RELEASES}.atom`,
        `http://ghe.example.com:8443/api/v3/repos/${OWNER}/${REPO}/releases/latest`,
        `http://ghe.example.com:8443${RELEASES}/download/v1.7.0/latest.yml`
      ])
    })
  })
})
