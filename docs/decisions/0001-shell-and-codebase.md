# 0001. Shell and codebase for RiftLauncher

Status: proposed. Date: 2026-08-16. Context: issue #18.

## The question

RiftLauncher is a fork of VS Launcher (Electron 43, React 18, TypeScript) that has been hardened and partly rebuilt: a portable domain layer, a path policy, an archive validator, 459 automated tests. Issue #18 framed the next decision as picking a shell once the domain extraction made the shell an adapter. A third path has since appeared, because Prospect exists: a finished C#/Avalonia launcher for the same game, written by Pixnop, with capabilities the fork does not have.

So the question is no longer only "which shell". It is:

- **A. Stay on Electron.** The fork continues as it is, the shell cost is accepted.
- **B. Port the fork's shell to Tauri v2.** Keep the React renderer, rewrite the trusted side in Rust.
- **C. Adopt Prospect as the base, renamed RiftLauncher.** Port over what the fork has that Prospect lacks.

Every number below was measured on 2026-08-16, on this machine, with the command named beside it. Where a number could not be measured, that is said instead of guessed.

## What was measured

### The fork

Measured in a worktree at `origin/dev` (efd654f) after `npm ci`.

| Layer                                   | Lines | How                                                   |
| --------------------------------------- | ----- | ----------------------------------------------------- |
| `src/domain`                            | 3179  | `find … -name '*.ts' -o -name '*.tsx' \| xargs wc -l` |
| `src/ipc` (handlers, adapters, workers) | 3082  | same                                                  |
| `src/main` + `src/preload`              | 476   | same                                                  |
| `src/renderer`                          | 9468  | same                                                  |
| `src/config` + `src/utils`              | 365   | same                                                  |
| `tests/`                                | 7668  | same                                                  |

Tests: 54 files, 458 passing and 1 skipped, from `npm test`. Coverage from `npm run test:coverage`: statements 46.91%, branches 53.77%, functions 50.67%, lines 46.30%. The floors in `vitest.config.ts` are 46 / 53 / 50 / 46, so the suite sits a fraction of a point above its own ratchet. The coverage `include` covers `src/domain`, `src/ipc`, `src/utils` and `src/config` only; `src/renderer` is deliberately outside the ratchet, which is why 9468 lines of renderer do not appear in that percentage.

Locales: 14 JSON files in `src/renderer/src/locales`, 347 leaf keys in `en-US.json`, with a parity test at `tests/i18n/i18n-parity.test.ts`.

Dependencies: 22 declared in `dependencies`, 87 packages in the resolved production tree (`npm ls --omit=dev --all --parseable`). One ships native binaries: `7zip-bin`, 11.9 MB in `node_modules`, of which 8.8 MB (six `7za` executables: linux arm, arm64, ia32, x64 and mac arm64, x64) lands in `app.asar.unpacked` on a Linux build.

Installed size, from `npm run build:unpack` then `du -sh dist/linux-unpacked`: **433 MB**. The breakdown is worth reading:

| Component                                      | Size   |
| ---------------------------------------------- | ------ |
| `vs-launcher` (Electron binary)                | 211 MB |
| `resources/app.asar`                           | 112 MB |
| `locales/` (Chromium, 55 files)                | 46 MB  |
| `LICENSES.chromium.html`                       | 20 MB  |
| `icudtl.dat`                                   | 11 MB  |
| `resources/app.asar.unpacked` (7-Zip binaries) | 9.4 MB |
| everything else                                | ~24 MB |

The app's own compiled code is 6.5 MB (`du -sh out`). The 112 MB asar is mostly not ours either: `react-icons` alone is 83 MB in `node_modules` and appears as 139 entries inside the asar (`npx asar list`), because electron-builder copies every `dependencies` entry whole even though the bundler already tree-shook it into those 6.5 MB. That 83 MB is avoidable under any of the three options and should not be charged to Electron.

Memory, dev mode, on a Wayland session, read from `/proc/<pid>/status` on the `electron-vite dev --watch` app already running on this machine. **These are dev-mode numbers**, with the Vite dev server attached and no production optimisations, and RSS summed across processes double-counts shared pages:

| Process                                  | VmRSS              |
| ---------------------------------------- | ------------------ |
| main (browser)                           | 307.6 MiB          |
| gpu-process                              | 241.4 MiB          |
| renderer                                 | 207.4 MiB          |
| utility (NetworkService)                 | 91.1 MiB           |
| three zygotes                            | 137.1 MiB combined |
| **sum of Electron processes**            | **984.6 MiB**      |
| `electron-vite` dev server (not shipped) | 222.3 MiB          |

What still binds the fork to Electron, recounted rather than quoted from issue #18: 18 files totalling 2472 lines import `electron`, `electron-log` or `electron-updater`. A further 5 files and 507 lines run on `node:worker_threads`. The IPC surface is 38 channels in `ipcChannels.ts` and 108 `window.api.*` call sites in the renderer. `src/domain` is consumed from both sides, 29 renderer files and 6 files under `src/ipc`.

Feature inventory, read from the code: game version catalog and install (Windows via the official installer run silently, Linux via archive extraction), version detection by probing the executable with `-v`, launch with `--dataPath`, uninstall. Installations with create, edit, delete, zip backups with retention and auto-backup before play, and a restore that stages into a sibling folder before swapping. ModDB browsing with filters and infinite scroll, mod install and bulk update, compatibility verdicts (`declared`, `same-minor`, `undeclared`), installed-mod scanning capped at 2000 archives, modpack export and import with a pure planner. Account login with 2FA, secrets in Electron `safeStorage` at mode 0600, session injected into the game's `clientsettings.json`. Self-update through electron-updater against GitHub releases. Twelve routes, a task manager with progress notifications and a close guard, 14 locales. On the trusted side: a path policy with symlink rejection and TTL-scoped user approvals, HTTPS allowlists, env-var sanitising, table-of-contents archive validation before any write, MD5 artifact verification against the official manifests, and Electron fuses with ASAR integrity.

### Prospect

Read-only, plus builds and test runs. .NET SDK 10.0.110.

| Project                           | Lines  | Files     |
| --------------------------------- | ------ | --------- |
| `src/Prospect.Core`               | 21 879 | 190 `.cs` |
| `src/Prospect.Desktop` (C#)       | 16 327 |           |
| `src/Prospect.Desktop` (`.axaml`) | 7292   |           |
| `tests/`                          | 48 130 |           |

Tests: **2582 discoverable** (`dotnet test --list-tests`), split 1665 Core, 910 Desktop, 7 GameConformance. Not 2600, close to it. `dotnet test` on `Prospect.Core.Tests` exits 0 with coverlet reporting 87.24% line, 77.64% branch, 91.75% method. `Prospect.Desktop.Tests` in Release: 907 passed, 3 skipped, 0 failed, in 65 seconds. In Debug the same suite fails 368 of 910, because `App.OnFrameworkInitializationCompleted` calls `AttachDevTools` and the headless lifetime rejects it; CI runs `dotnet test --no-build -c Release`, so this only bites someone running the suite the obvious way on their laptop.

Installed size, `dotnet publish -c Release -r linux-x64 --self-contained true` into a scratch directory: **109 MB**, 229 files. Adding `-p:PublishTrimmed=true` fails to build: `TreatWarningsAsErrors` is on globally and the trimmer raises IL2026 on `ResourceInclude` in `LanguageService` and on the reflection bindings in `RichTextPresenter`, plus IL2057 on `ViewLocator`. So 109 MB is today's number, not a floor, and trimming is available only after work that has not been done.

Idle memory: **289.6 MiB** VmRSS, single process, 32 threads, measured 40 seconds after launching that self-contained build on the same Wayland session, with `XDG_DATA_HOME` pointed at a scratch directory. It wrote exactly one file there, `prospect/prospect.json`, and nothing under `~/.config`. This is a Release build, so it is not directly comparable with the fork's dev-mode figures; the honest comparison is one Avalonia process at 290 MiB against an Electron main process alone at 308 MiB, before its five siblings.

Four capabilities the fork does not have:

- **Mod dependency resolution.** `src/Prospect.Core/ModDb/ModDependencyResolver.cs`, 183 lines, pure. Reads the downloaded archive's own `modinfo.json`, indexes installed mods by both `modid` and ModDB id, and returns one of `Missing`, `Disabled`, `TooOld`, `Satisfied` per dependency, checking "disabled" before "too old" because the engine will not load a disabled mod whatever its version. Transitive resolution comes only from the server's `resolve-deps` response and is flagged as such. `FindDependents` runs the reverse check so the uninstall dialog names what will break. No conflict resolution, no version-range intersection. The fork resolves nothing at all, and says so in a comment in `src/domain/mods/importModpack.ts`.
- **Inno Setup payload extraction.** `src/Prospect.Core/GameVersions/Inno/`, 9 files, roughly 1820 lines, pure C# apart from SharpCompress as an LZMA decoder. It finds the loader offsets, verifies CRC32 on every block, parses the setup script far enough to reach the `[Files]` table, undoes Inno's x86 CALL/JMP address transform, extracts only entries destined for `{app}`, and checks every written file against the SHA-256 the installer declares. It exists because running the installer runs its script, and that script's `InitializeSetup` pops a MsgBox that `/SUPPRESSMSGBOXES` cannot reach, keyed off a registry value the installer itself wrote. The fork takes the other route: `RUN_INSTALLER` spawns the real `.exe` with `/VERYSILENT`, bounded by a 15-minute timeout with a process-tree kill, which is issue #55's territory.
- **Migration rails.** Two pipelines, `Instances/Migrations/` (instance.json v1 to v2 to v3) and `Settings/Migrations/` (registered with an empty list). One migration is one tested class, and a broken chain throws rather than guessing.
- **Conformance tests on real files.** `tests/Prospect.GameConformance.Tests` boots a real headless Vintage Story server inside the test process through `Pixnop.Atlas.XUnit`, compiles against the real `VintagestoryAPI.dll`, and checks three things nobody can check by reasoning: that renaming a mod to `.zip.disabled` really does make the engine skip it, that `GamePaths.DataPathMods` and friends match the folder names Core hardcodes, and that `ModInfoParser` agrees field for field with the real `ModLoader` on four legal but gnarly `modinfo.json` files. Fixtures are generated at runtime, the engine is downloaded by CI, and the whole tier is double opt-in (a build-time `VINTAGE_STORY` variable and a run-time `PROSPECT_CONFORMANCE=1`), which is why those 7 tests skip instantly in a normal run.

UI languages: **2**. French and English. The mechanism is two halves and neither is a data file a translator can edit. Static XAML strings live in `Resources/Strings.fr.axaml` and `Strings.en.axaml`, 243 `x:Key` entries each, merged at startup by `Services/LanguageService.cs` and never re-read. Computed strings live in a C# class hierarchy: `Resources/UiTextTable.cs` declares 264 abstract members across 17 nested section types, and `FrenchUiText.cs` and `EnglishUiText.cs` each override 245 of them. Many are methods with parameters, not strings. Language selection is literally `language == "en" ? English : French` in `ProspectSettings.NormalizeLanguage`, and there is no hot switching, which `docs/architecture.md` records as a decision rather than a gap.

One thing Prospect already has that changes the shape of option C: **the VS Launcher import is built and shipped**. `src/Prospect.Core/Migration/`, 14 files, 1246 lines, reachable from Settings and from the first-run checklist. It probes `XDG_CONFIG_HOME/VSLauncher/config.json` (Electron's `appData`, not `XDG_DATA_HOME`, and the code carries a comment warning against confusing the two), parses installations and game versions, tokenises the single-string start params and env vars into Prospect's one-per-line lists, and copies rather than moves so VS Launcher survives intact. It is schema-agnostic by accident of design: `VslConfigParser` reads no version marker at all, so a config carrying the fork's new integer `schemaVersion: 2` parses exactly like a float-era `version: 1.6` one.

What it does not carry over, checked field by field against the fork's schema in `src/config/configManager.ts`: per installation, `icon`, `backupsLimit`, `backupsAuto`, `compressionLevel` and the whole `backups[]` array; globally, `account`, `favMods`, `customIcons`, `window`, `lastUsedInstallation` and the three configurable root folders. `VSLBackups/` is deliberately never adopted.

Gaps on Prospect's side, all read from its code: **no self-update mechanism of any kind** (`SettingsAboutViewModel` says so in its own docstring and deliberately omits the button the mockup drew), modpack export and import fully implemented in Core and tested but with zero UI and no DI registration, and no data-root relocation (`AppPaths` takes a `rootOverride` that nothing passes).

Contributors, from the GitHub API on `Pixnop/Prospect`: **one**. Pixnop, 49 contributions. I could not run `git shortlog` against that checkout from this worktree, so the API is the source.

## Option A: stay on Electron

**What the team gains.** Nothing new, which is the point. The rebuild continues on a codebase where 458 tests already pass, where the security work (path policy, archive validation, artifact verification, fuses) is done and tested, and where the next contributor writes TypeScript. Twelve routes ship today in 14 languages. Time to value is zero because there is nothing to port.

**What it costs.** 433 MB installed on Linux, of which 211 MB is a private Chromium and 46 MB is Chromium's own locale bundle for languages the app does not use. Around 985 MiB of summed dev-mode RSS across seven processes. Four worker entrypoints, 507 lines, each with its own timeout and a termination hook on `before-quit`, which is machinery that exists because Node has no other way to keep the main process responsive during a 600 MB download. Six `7za` binaries in the package, and the whole archive-validation layer partly exists because shelling out to `7za l -slt` is the only way to read a table of contents from formats yauzl and node-tar do not handle. And Electron 43 tracks Chromium, so the shell has a security update cadence set by someone else, on a schedule the team cannot negotiate.

**What breaks for existing VS Launcher users.** Nothing. The config file, the folder layout and the update feed all stay where they are.

**Who can maintain it.** In principle the team, in practice one person. The shortlog over the whole 509-commit history shows 25 identities, but 308 of those commits are XurxoMF's upstream VS Launcher. Since 2026-02-01 the fork's own work is 121 commits from Pixnop (across two author names on the same GitHub account), 22 from Tom Marsh, 7 upstream, and 2 from Zaldaryon. Since 2026-08-01 it is 121 Pixnop and 2 Zaldaryon. The bus factor on the fork is better than one only because the language is one more people already read, not because more people are currently writing it.

## Option B: port the shell to Tauri v2

**What the team gains.** The renderer survives: 9468 lines of React, 12 routes, 14 locale files, all of it untouched. `src/domain`, 3179 lines of portable TypeScript, keeps running in the webview. The installed size drops by most of the 211 MB Electron binary and the 46 MB of Chromium locales, because the system webview replaces both. Issue #18's "10 to 15 MB installed, memory divided by three or four" is the right order of magnitude for a Tauri app, though it is not a number this dossier measured, because no prototype exists.

**What it costs.** The Rust rewrite surface, recounted against today's tree rather than the tree issue #18 was written against: 2375 lines that import Electron (2472 minus the 97-line preload, which has no Tauri equivalent), plus 507 lines of workers, plus 634 lines that do not import Electron today but must not run inside a webview either (`validation.ts` 321, `archiveValidation.ts` 224, `artifactVerification.ts` 89). About **3500 lines of TypeScript to re-express in Rust**, against the ~2900 the issue estimated. On top of that, 38 IPC channels and 108 call sites re-pointed at `invoke`, and a decision about the 6 files under `src/ipc` that import `@domain`: either those code paths move into the webview or the domain gets a Rust twin.

The lines are the easy part. The hard part is that `pathPolicy.ts` (166 lines: symlink rejection anywhere in the path, TTL-scoped approvals for user-picked folders, a protected-path deny list for deletions) and `archiveValidation.ts` (224 lines of table-of-contents checking across zip, tar.gz and 7z, with limits on entry count, entry size and total size) are the security core, and re-implementing them in a language nobody on the team has shipped is where the risk actually sits. My estimate is 30 to 50 person-days for a port with the same security properties, assuming the team learns Rust on the job. I hold that number loosely. It is the least defensible estimate in this document, and the way to make it defensible is the one-screen prototype issue #18 already asked for.

**What breaks for existing VS Launcher users.** The auto-update chain. electron-updater and `tauri-plugin-updater` use different manifests and different signing, so shipping a Tauri build to the existing feed does not work: the team would need one final Electron release whose job is to point users at the new installer, and would have to accept that anyone who does not take that release is stranded. The config file itself can survive, since the format is ours and `migrateConfigDocument` already exists.

**Who can maintain it.** Nobody today, by definition, until somebody learns Rust. That is not an argument against it, but it is the argument the team has to answer.

## Option C: adopt Prospect as the base

**What the team gains.** A launcher that is already finished, and four capabilities the fork does not have and would each be real work to build: dependency resolution, pure-C# Inno payload extraction, migration rails with tested one-class-per-step pipelines, and a conformance tier that boots the real game engine and checks the launcher's assumptions against it rather than against a mock. 2582 tests, 87% line coverage on Core. 109 MB installed rather than 433 MB, and 290 MiB idle in one process. The VS Launcher import already exists and already works. And Prospect is written in the same language as the game and its mods, which matters for a launcher whose whole job is understanding what the game does with a folder.

**What it costs.** Everything the fork has that Prospect does not, plus the language.

_Locales, 4 to 6 person-days for the mechanism._ The XAML half is mechanical: 243 keys per file, add an `AvaloniaResource` glob, make URI resolution table-driven, widen `StringsDictionaryParityTests` from a two-way to an N-way comparison. The C# half is the cost, because 264 abstract members with method signatures cannot be expressed in a JSON key/value file. Either a source generator emits a `UiTextTable` subclass per locale (keeps the compile-time parity guarantee that is the design's whole point) or the abstract-member design is replaced by dictionary lookups with format strings (simpler, throws away the guarantee, touches every ViewModel call site). I priced the source generator. Assumption: one developer already fluent in both codebases.

_The translations themselves are not in that estimate and are not the team's to spend._ 243 XAML keys plus 245 C# members is 488 strings per locale; thirteen locales beyond English is roughly 6300 strings. The fork's 347 `en-US.json` keys are a glossary, not a source: the two products do not share screens, so almost nothing transfers verbatim. And the 14 locales exist in the first place because a translator could edit JSON in a browser, following the GitBook instructions in `docs/get-started/translation/`. Keeping a JSON surface for translators, with a generator producing the `.axaml` and the C# behind it, is another 2 to 3 days. Skip it and the practical outcome is two locales, whatever the mechanism supports.

_User data, 3 to 5 person-days on top of what exists._ The import rails are built; the gaps listed above are the work. Most of that estimate is backups, because the two products disagree about what a backup is: the fork zips the whole installation folder to `<backupsFolder>/Installations/<name>/<name>_<epoch>.zip`, Prospect zips only `data/` to `instances/<slug>/backups/<yyyyMMdd-HHmmss>.zip`. An adopted archive has to be repacked, not copied, and a repack that gets the layout wrong loses somebody's world.

_Self-update, 8 to 12 person-days, and this is the estimate I trust least,_ because none of it exists to read. Prospect distributes through GitHub releases with no updater at all. The fork's users have auto-update today and would lose it on day one.

_Modpack UI, 3 to 4 days._ The Core services are written and tested; nothing is registered in `CompositionRoot` and there is not one `Modpack` reference in `Prospect.Desktop`.

_Favourite mods, custom PNG icons, and task-progress surfaces, 3 to 5 days._

That totals roughly 23 to 35 person-days, excluding translations and excluding onboarding, for one developer who already knows both codebases. Which today means one person, and that is the same person either way.

**Parity runs in both directions, and it is not one-sided.** Prospect has screens the fork does not: an instance detail page with Worlds, Journal and Options tabs, an instance doctor running five offline checks, game-log analysis with per-mod badges, instance duplicate and rename, broken-instance and broken-install strips instead of silent failures, mod enable and disable through the `.zip.disabled` convention verified against the real engine, a downloads popover with a concurrency setting and resumable downloads with a per-read inactivity timeout, themes and backdrops, and a first-run checklist. Prospect also has a macOS install strategy; the fork declares mac build targets but `gameExecutable.ts` returns an empty list for macOS, so it cannot launch the game there. The fork has, and Prospect lacks: self-update, modpack UI, favourite mods, custom icons, and twelve more languages.

**What breaks for existing VS Launcher users.** Less than you would expect, and more than nothing. Installations and game versions come across through a path that already exists and is already tested. Backups do not, yet. Accounts, favourites and custom icons do not. Auto-update stops, because there is nothing on the other side to update from. And the import copies rather than moves, so a user who tries it and dislikes it still has VS Launcher, which is the right default and worth keeping.

**Who can maintain it.** One person. Prospect has exactly one contributor, Pixnop, 49 contributions on GitHub, one identity across all 166 reflog entries, `<Authors>Pixnop</Authors>` in `Directory.Build.props`, and a conformance harness that depends on that same author's own `Pixnop.Atlas.XUnit` package. Nobody else on the team has written a line of it. Adopting it does not raise the bus factor; it lowers it, unless somebody else learns C# and Avalonia, and it adds a dependency on a personal NuGet package for the test tier that verifies the launcher's assumptions about the game.

## The criteria that actually discriminate

Installed size does not discriminate the way issue #18 assumed. 433 MB measured against the 150 to 200 MB the issue estimated, and 83 MB of that is a packaging mistake that any option fixes. Prospect's 109 MB is real but untrimmed, and Tauri's number is unmeasured. Size separates A from the others; it does not separate B from C.

**Team language comfort.** The fork is TypeScript, which the team reads. Prospect is C#, which one person writes. Tauri means Rust, which nobody writes. This is the criterion that decides how many people can review a security fix, and it is a question for the team rather than a number: who is willing to learn what, and by when.

**Two-year maintainability.** Electron hands the team a Chromium update cadence it does not control and cannot skip. Tauri hands it the system webview, which means the target moves per OS and per user rather than per release. C# on .NET 10 has an LTS window and one ADR (`docs/adr/0001-cible-net10.md`) explaining exactly why that version. The thing to weigh against Prospect's better numbers is that its documentation is written for one reader: 90 KB of `architecture.md` in French, one ADR, and extremely thorough docstrings, also in French. That is excellent for the author and a real cost for the second maintainer.

**User data continuity.** A is free. C is mostly built, with the backup repack and the account carry-over as identified, sized work. B keeps the config file but breaks the update chain, and so does C. The sharpest version of this criterion: an existing user who never opens the launcher again after the switch should still be able to play, and under B and C that user stops receiving updates unless one last Electron release tells them where to go.

**Time to value.** A ships tomorrow. C ships once the 23 to 35 days are spent, and the users who care most about the 14 locales are waiting on 6300 translated strings that nobody on this team can produce. B ships after a Rust learning curve nobody has started, and the honest first step is the one-screen prototype issue #18 asked for and that still does not exist.

One more thing worth putting on the table before the vote, because it undercuts the framing in issue #18: the fork's bus factor and Prospect's are closer than "the team's codebase" versus "one person's codebase" suggests. Since February, 121 of the fork's 154 commits are Pixnop's. The difference between A and C on this axis is a language barrier, not a headcount.

Decision: pending. Deciders: the team (Zaldaryon, Pixnop).
