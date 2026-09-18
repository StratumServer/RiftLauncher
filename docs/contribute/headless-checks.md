# Headless checks on the packaged build

`scripts/headless/` drives a real packaged RiftLauncher build with no window: the same binary
electron-builder ships, launched with Chromium's headless Ozone backend and driven over the Chrome
DevTools Protocol (CDP). It exists so a PR that touches anything a screenshot or a page read would
catch can be checked against the actual packaged app, not just against `npm run dev`, without a
maintainer's own desktop ever showing a window for it.

This never launches the game. It never clicks Play. It is a way to look at the launcher's own UI
(a page's text, a dialog, a list) headlessly, and nothing more.

## Never run the bare binary

`dist/linux-unpacked/riftlauncher`, run directly, opens the app on your real profile: your real
`config.json`, your real installations, your real accounts. Every command below points the binary
at a throwaway profile instead, through `XDG_CONFIG_HOME` / `XDG_CACHE_HOME` / `XDG_DATA_HOME`. If
you ever run the binary without those three set to a scratch folder, you are looking at your own
launcher, not a check.

## Build

```sh
npm run build:unpack
```

This is `electron-vite build` plus `electron-builder --dir`, producing `dist/linux-unpacked/`
without packing an installer. Rebuild it after any source change you want the headless check to
see; it does not watch.

If you are working in a separate git worktree (recommended, so this never touches a checkout with
uncommitted changes), copy `node_modules` in rather than symlinking it:

```sh
cp -a /path/to/main/checkout/node_modules node_modules
```

electron-builder's dependency walk does not follow a `node_modules` that is itself a symlink into
another checkout, and drops packages a real copy would have kept (`universalify`, among others,
which `fs-extra` needs at runtime). A build out of a symlinked `node_modules` looks fine and then
fails the moment the packaged app touches a file. Copying costs disk space and a few seconds; a
build that silently ships broken costs a lot more.

## Seed a profile

```sh
node scripts/headless/seed.mjs spec.json /tmp/some-profile
```

`spec.json` describes the installations to fabricate (name, game version, and any local Mods to
give it) plus a few optional flags. See the header comment in `scripts/headless/seed.mjs` for the
full shape and `tests/config/headlessSeed.test.ts` for a spec that is validated, end to end,
through the launcher's own `normalizeConfig`. A minimal one:

```json
{
  "installations": [{ "name": "Check", "gameVersion": "1.20.4", "mods": ["Primitive Survival"] }]
}
```

The seed writes `config.json` at today's schema and creates the managed `RiftLauncherInstallations`
/ `RiftLauncherGameVersions` folders under `<profile>/config`, so the profile is exactly what a real
first run would have built, minus actually downloading a game version. Mods are fabricated as
modinfo-only zips: enough for the Mods list to identify them, nothing that would run.

## Launch

```sh
scripts/headless/launch.sh /tmp/some-profile 9561
```

Prints the launched process's PID and returns immediately; the app keeps starting in the
background. Give the CDP port a moment (poll `http://127.0.0.1:9561/json/list` until it answers,
or just wait a couple of seconds) before driving it.

### Ports

Pick a port outside the common defaults (9222 is Chrome's own default debugging port; electron-vite
dev uses 5173) so a headless check never collides with a real browser or dev-server session on the
same machine. There is no single reserved port: more than one of these can run at once, on the same
box or across a few reviewers, so give each concurrent check its own (9560, 9561, 9562, ...).

## Drive

```sh
CDP_PORT=9561 node scripts/headless/cdp.mjs text
CDP_PORT=9561 node scripts/headless/cdp.mjs eval "window.location.hash = '/installations/mods/check'"
CDP_PORT=9561 node scripts/headless/cdp.mjs clickText "Not this time"
CDP_PORT=9561 node scripts/headless/cdp.mjs size 1024x600
```

`node scripts/headless/cdp.mjs --help` lists every command (`text`, `eval`, `clickText`, `click`,
`clickxy`, `type`, `key`, `shot`, `size`). Navigation has no dedicated command: the app is a
`HashRouter`, so `eval "window.location.hash = '/some/route'"` is how a check moves between pages.

A fresh profile shows the "Help other players find RiftLauncher" ModDB prompt on first launch
unless the seed spec answered it in advance (`moddbVisibilityAnswer`). `clickText` is how a live
check answers it without pre-seeding, the same way a first-time player would.

## Screenshot

```sh
CDP_PORT=9561 node scripts/headless/cdp.mjs shot /tmp/some-profile/shots/home.png
```

Set the viewport with `size` first; screenshots are taken at whatever size was last set (or the
build's default window size otherwise).

## Stop

```sh
scripts/headless/stop.sh <pid>
```

The PID `launch.sh` printed, nothing else. This never kills by process name or pattern: more than
one headless launcher, or a reviewer's own dev instance, can be running on the same machine at the
same time, and a pattern match cannot tell them apart.

## How reviewers use this

For a PR whose change could plausibly show up on screen (layout, a new dialog, a list's contents,
anything CSS), a reviewer builds `dev` plus the PR branch each into their own `dist/linux-unpacked`,
seeds matching profiles, launches both on different ports, and drives each to the same route for a
side-by-side screenshot instead of trusting the diff to say what the page looks like. For a change
that reads as a behavioral claim in the PR description ("the Mods list now shows X"), the same setup
answers it directly: seed a profile that exercises the claim, launch, `eval`/`text`/`shot` to check
it, `stop.sh` when done.
