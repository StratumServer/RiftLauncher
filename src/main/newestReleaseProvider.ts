import { readFile } from "node:fs/promises"
import { join } from "node:path"
import semver from "semver"

import type { AppUpdater, UpdateInfo } from "electron-updater"
import type { GitHubProvider } from "electron-updater/out/providers/GitHubProvider.js"

/**
 * Who is offered which release, when prereleases are allowed.
 *
 * electron-updater's own GitHub provider (6.8.9, providers/GitHubProvider.js, getLatestVersion)
 * picks the release from the running version's first prerelease identifier, the "channel", and it
 * knows exactly two of them, alpha and beta. Any other identifier, `rc` included, is a "custom
 * channel": a client on a beta never sees an `-rc` tag, a client on an `-rc` only ever takes the
 * next `-rc` and never the stable release after it, and a stable client takes whatever entry heads
 * the feed, a bare git tag with no release among them (the metadata file is a 404 and the whole
 * check fails).
 *
 * This provider keeps everything the stock one does (download URLs, the blockmap of the running
 * version, the signature check) and replaces only the choice of release when prereleases are
 * allowed: the newest tag by semver among stable, alpha, beta and rc that is not older than the
 * running version and whose update metadata exists. electron-updater itself still refuses an
 * offer that is not strictly newer than the running version, so nothing here can downgrade.
 * With prereleases off the stock code runs untouched: GitHub's own "latest release", which is
 * never a draft or a prerelease.
 */

/** The prerelease identifiers the release workflow publishes, and the ones the launcher is willing to follow. */
const KNOWN_PRERELEASES = new Set(["alpha", "beta", "rc"])

/** Where the releases live, as resources/app-update.yml names them. */
export interface GitHubFeed {
  owner: string
  repo: string
  /** GitHub Enterprise or a test server, with its port if any. Absent means github.com. */
  host?: string
  protocol?: "http" | "https"
}

type ProviderRuntimeOptions = ConstructorParameters<typeof GitHubProvider>[2]
type ParseUpdateInfo = (rawData: string | null, channelFile: string, channelFileUrl: URL) => UpdateInfo
type NewestReleaseProviderClass = new (options: unknown, updater: AppUpdater, runtimeOptions: ProviderRuntimeOptions) => GitHubProvider

/** The tags of a `releases.atom` feed, newest first as GitHub lists them. The feed's own link to `/releases` has no `/tag/` and is not one. */
export function tagsFromReleasesFeed(xml: string): string[] {
  return [...xml.matchAll(/href="[^"]*\/releases\/tag\/([^"/]+)"/g)].map((match) => decodeURIComponent(match[1] ?? ""))
}

/**
 * The tags worth asking for update metadata, best first.
 *
 * A tag that is not a semver version, one older than the running version, and one whose
 * prerelease identifier is not alpha, beta or rc are all dropped. The running version's own tag
 * stays: it is what answers "nothing newer" when every newer tag turns out to have no release.
 */
export function updateCandidateTags(tags: readonly string[], runningVersion: string): string[] {
  return tags
    .filter((tag) => {
      const version = semver.valid(tag)
      if (!version || semver.lt(version, runningVersion)) return false
      const channel = semver.prerelease(version)?.[0]
      return channel === undefined || KNOWN_PRERELEASES.has(String(channel))
    })
    .sort((a, b) => semver.rcompare(a, b))
}

/**
 * The repository resources/app-update.yml points at, with the `host` and `protocol` electron-updater's
 * GitHub options also carry, or null when it is not a plain GitHub feed. A host or protocol that is
 * present but unreadable gives null too: dropping it would silently aim the feed at github.com.
 */
export function githubFeedFromAppUpdateYml(text: string): GitHubFeed | null {
  const line = (key: string): string | undefined => new RegExp(`^${key}:[ \\t]*(.*?)\\s*$`, "m").exec(text)?.[1]
  const value = (key: string, pattern = /^[\w.-]+$/): string | undefined => {
    const raw = line(key)
    return raw !== undefined && pattern.test(raw) ? raw : undefined
  }
  const owner = value("owner")
  const repo = value("repo")
  const host = value("host", /^[\w.-]+(:\d+)?$/)
  const protocol = value("protocol", /^https?$/) as GitHubFeed["protocol"]
  if (value("provider") !== "github" || !owner || !repo) return null
  if ((line("host") !== undefined && !host) || (line("protocol") !== undefined && !protocol)) return null
  return { owner, repo, ...(host && { host }), ...(protocol && { protocol }) }
}

/**
 * The provider class to hand to `setFeedURL({ provider: "custom", updateProvider })`.
 *
 * The base class and `parseUpdateInfo` are passed in because electron-updater does not export
 * them from its entry point, so the caller loads them from their module files.
 */
export function newestReleaseProvider(Base: typeof GitHubProvider, parseUpdateInfo: ParseUpdateInfo, feed: GitHubFeed): NewestReleaseProviderClass {
  return class NewestReleaseProvider extends Base {
    private readonly appUpdater: AppUpdater

    constructor(_options: unknown, updater: AppUpdater, runtimeOptions: ProviderRuntimeOptions) {
      super({ provider: "github", ...feed }, updater, runtimeOptions)
      this.appUpdater = updater
    }

    override async getLatestVersion(): ReturnType<GitHubProvider["getLatestVersion"]> {
      if (!this.appUpdater.allowPrerelease) return super.getLatestVersion()

      const running = this.appUpdater.currentVersion.version
      const releases = `/${this.options.owner}/${this.options.repo}/releases`
      const atom = await this.httpRequest(new URL(`${releases}.atom`, this.baseUrl), { accept: "application/xml, application/atom+xml, text/xml, */*" })
      const channelFile = `${this.getDefaultChannelName()}.yml`

      for (const tag of updateCandidateTags(tagsFromReleasesFeed(atom ?? ""), running)) {
        const url = new URL(`${releases}/download/${tag}/${channelFile}`, this.baseUrl)
        try {
          return { tag, ...parseUpdateInfo(await this.executor.request(this.createRequestOptions(url)), channelFile, url) }
        } catch (error) {
          // A bare git tag and a draft have no published metadata: skip them. Anything else is a real failure.
          if ((error as { statusCode?: number }).statusCode === 404) continue
          throw error
        }
      }
      throw new Error(`No release from ${running} on carries ${channelFile}`)
    }
  }
}

/**
 * Makes the updater follow {@link newestReleaseProvider}, for the repository its own
 * resources/app-update.yml names. Returns false, and leaves the stock provider in place, when
 * that file does not describe a GitHub feed.
 */
export async function installNewestReleaseProvider(autoUpdater: AppUpdater, resourcesPath: string = process.resourcesPath): Promise<boolean> {
  const feed = githubFeedFromAppUpdateYml(await readFile(join(resourcesPath, "app-update.yml"), "utf8"))
  if (!feed) return false

  // Not exported from electron-updater's entry point. The ".js" is required by node's ESM resolution.
  const [{ GitHubProvider }, { parseUpdateInfo }] = await Promise.all([import("electron-updater/out/providers/GitHubProvider.js"), import("electron-updater/out/providers/Provider.js")])
  autoUpdater.setFeedURL({ provider: "custom", updateProvider: newestReleaseProvider(GitHubProvider, parseUpdateInfo, feed) })
  return true
}
