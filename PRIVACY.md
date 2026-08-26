# RiftLauncher Privacy Policy

Last updated: 2026-08-26

This policy explains what information RiftLauncher handles when you use the desktop application. RiftLauncher is an independent community project maintained by Zaldaryon and contributors. The source code is available at [github.com/StratumServer/RiftLauncher](https://github.com/StratumServer/RiftLauncher).

This policy covers the RiftLauncher application. It does not cover Vintage Story, the Vintage Story websites, ModDB, GitHub, YouTube, Discord, OpenCollective, or any other service that RiftLauncher opens or contacts. Those services have their own policies and control the data they receive.

## Information stored on your device

RiftLauncher stores its configuration in the application user-data directory on your device. This can include installation and version paths, installation names, backup paths and dates, mod favorites and update preferences, window settings, selected backgrounds, custom icons, and the account profile shown in the launcher.

If you sign in to a Vintage Story account, RiftLauncher sends the email address, password, and optional two-factor code that you enter to the official Vintage Story account endpoint at [auth3.vintagestory.at/v2/gamelogin](https://auth3.vintagestory.at/v2/gamelogin) over HTTPS. The password and two-factor code remain in memory while you complete the login request, then the launcher clears those input fields and does not store or write them to the launcher logs. A successful response provides the player name, player UID, entitlement information, game-server entitlement status, and session credentials. RiftLauncher stores the non-secret account profile in its local configuration and stores the session key, session signature, and multiplayer token in an encrypted local account file using the operating system storage provided by Electron.

When RiftLauncher starts a game, it writes the account profile and session fields needed by the official client into the selected installation's local `clientsettings.json`. This lets Vintage Story authenticate the player. Those values then belong to the local game installation and can be read by the official game or other software with access to that file. Logging out removes the encrypted RiftLauncher session file and clears the account shown in the launcher. It does not automatically remove session fields already written to existing `clientsettings.json` files.

RiftLauncher also writes local logs and caches. Logs contain operational messages and diagnostic errors. The logger redacts recognized passwords, tokens, authorization values, and path patterns before writing them, but you should review a log before sharing it. RiftLauncher does not upload these logs or caches to the project maintainers.

RiftLauncher reads and writes local game installations, mods, worlds, backups, configuration files, modpack files, and user-selected background or icon files when you ask it to perform those actions. It does not send those files to the RiftLauncher maintainers.

## Requests to external services

RiftLauncher makes network requests only for launcher functions and user-selected features:

- The official Vintage Story account service receives login data when you choose to sign in.
- The official Vintage Story catalog and download service receive requests for version manifests and game packages when you browse or install a game version.
- The Vintage Story ModDB receives requests for mod catalogs, mod details, icons, and downloads when you use mod features.
- After an explicit one-time acceptance in the launcher, RiftLauncher may request a small archive from the RiftLauncher ModDB listing so that ModDB records a listing download. This request is not made at startup, does not use your Vintage Story credentials, and the downloaded pointer archive is not retained by RiftLauncher.
- GitHub Releases receives update checks and update downloads when the launcher checks for or downloads an application update. Raw GitHub and the ModDB content network may receive requests for selected background images and thumbnails.
- YouTube may receive requests when you view the project trailer or its thumbnail. Other links, such as GitHub issues, Discord, or OpenCollective, open in the browser only when you choose them.

The services above can receive normal connection metadata such as an IP address, request time, and protocol or user-agent information. RiftLauncher does not control their logging or retention. Read the relevant service policy before using that service: [Vintage Story Privacy Policy](https://www.vintagestory.at/privacy/), [ModDB Privacy Policy](https://www.moddb.com/privacy-policy), [GitHub General Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement), and [Google Privacy Policy](https://policies.google.com/privacy).

## What RiftLauncher does not collect

RiftLauncher does not operate a project account service, advertising system, telemetry endpoint, analytics service, or crash-reporting service. It does not sell personal information and does not send local worlds, backups, mods, logs, or configuration files to the project maintainers. The official Vintage Story client may have its own network behavior after RiftLauncher launches it; that behavior is governed by Anego Studios and the official client's policies, not by this project.

## Retention and deletion

Local data remains on your device until you remove it. Use the logout control to remove the encrypted RiftLauncher session credentials. To remove launcher configuration, logs, and caches, use the operating system's application-data controls or remove the RiftLauncher user-data directory after closing the application. Installed game versions, installations, worlds, mods, backups, and `clientsettings.json` files can live in separate directories and require separate review or deletion. Removing RiftLauncher does not promise to remove files that you selected or created outside its installation directory.

RiftLauncher has no project server that stores account records or uploaded launcher data. External services retain data they receive according to their own policies.

## Security

RiftLauncher uses HTTPS for its configured network requests and uses Electron's operating-system-backed secure storage for the session credentials it keeps locally. No local software can guarantee the security of a compromised device. Keep your operating system, game installation, account, and local configuration files protected, and do not share passwords, session values, or unreviewed logs.

## Changes to this policy

The maintainers may update this policy when the application's data handling changes. The date at the top of this page records the latest revision. The public repository and release documentation will link to the current version.

## Contact

For a general privacy question, open an issue in the [RiftLauncher repository](https://github.com/StratumServer/RiftLauncher/issues) or contact the maintainers through the [Stratum Discord server](https://discord.gg/vQm6z2urZs). Do not include passwords, session credentials, account identifiers, or private logs in a public post. For a security report, follow the private reporting instructions in [SECURITY.md](SECURITY.md).

## Implementation references

The relevant data flows are visible in the public source: [account login](src/ipc/handlers/accountHandlers.ts), [encrypted account storage](src/ipc/accountStore.ts), [client session transfer](src/domain/account/clientSettings.ts), [network allow-list](src/ipc/validation.ts), [ModDB request handling](src/ipc/handlers/netHandlers.ts), and [application updates](src/ipc/handlers/appUpdaterHandlers.ts).
