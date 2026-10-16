---
icon: hard-drive
description: Keep RiftLauncher's settings in a folder next to the launcher instead of your user folder.
---

# 💼 Portable profile

RiftLauncher keeps its profile, meaning your settings, your list of Installations and VS Versions, your saved accounts and your own background pictures, in your user folder: `%APPDATA%\RiftLauncher` on Windows and `~/.config/RiftLauncher` on Linux. A portable profile keeps it in a `RiftLauncherData` folder beside the launcher instead, so the launcher and its profile can sit together on another drive.

It works with the Windows installer and with the Linux AppImage. The `.deb`, `.rpm` and `.pacman` packages always use the usual Linux folder, and there is no macOS build.

## Turn it on

You switch it on with an empty file named `RiftLauncher.portable`. RiftLauncher looks for it when it starts.

### On Windows

<!-- VERIFY: the manual Windows pass of the release candidate (#635) covers the portable profile; check these steps against its report before publishing. -->

1. Install RiftLauncher in a folder on the drive you want, for example `D:\Games\RiftLauncher`. Your Windows account has to be able to create files in the folder above it, here `D:\Games`.
2. Close RiftLauncher.
3. Create an empty file named `RiftLauncher.portable` in that folder above, so here `D:\Games\RiftLauncher.portable`.
4. Start RiftLauncher. It creates `D:\Games\RiftLauncherData` and keeps its profile there from now on.

For step 3, in PowerShell:

```powershell
New-Item -ItemType File -Path "D:\Games\RiftLauncher.portable"
```

In File Explorer, turn on file name extensions first, otherwise a new text document renamed this way ends up as `RiftLauncher.portable.txt`.

The marker and the data folder sit outside the install folder, so updating or uninstalling RiftLauncher leaves both alone.

### On Linux (AppImage)

Close RiftLauncher, open a terminal in the folder that holds the AppImage and create the marker:

```sh
touch RiftLauncher.portable
```

Start the AppImage again. It creates a `RiftLauncherData` folder beside it.

The marker and the data folder have to belong to your own account. While you are there, give the AppImage a name without a version number, such as `RiftLauncher.AppImage`, so updates replace it in place and your shortcuts keep working.

## What the first portable start does

The first start with the marker copies your current profile into `RiftLauncherData`, your own background pictures included, and leaves the original where it was. If you never used RiftLauncher on this computer, it brings over VS Launcher's settings and Installation icons instead, the same way a normal first start does.

To check which profile is in use, open the Config page: **Profile folder**, under Folders, shows the folder, and the button beside it opens it.

## Your game files stay where they are

Only the profile moves. Installations, VS Versions and Backups you already have keep their folders, wherever they are. New ones go under `RiftLauncherData` unless you pick another folder.

RiftLauncher saves full paths in its settings, so once the portable profile is set up, moving `RiftLauncherData` or the launcher to another folder or drive letter breaks those paths unless you edit them in `config.json` by hand.

## On another computer

A portable profile carried to another computer, or to another account on the same computer, keeps its settings and Installations but not your logins. A saved login lives in the system's keyring, on the computer and account where you logged in, so you log in again there.

## Updates

Updates still download to your system drive: `%LOCALAPPDATA%\riftlauncher-updater\pending` on Windows, `~/.cache/riftlauncher-updater/pending` on Linux. That drive needs room for one download even when everything else is on another drive.

## When the folder cannot be used

The marker has to be an empty file, not a link to one. A marker with anything written in it is ignored, and RiftLauncher starts on the profile in your user folder as if it were not there. On Linux the same goes for a marker that belongs to another account.

If the marker is right but the portable profile cannot be set up, for example because the copy of your current profile fails, RiftLauncher shows the reason and does not start, rather than starting on the wrong profile. Fix what it names and start it again.

Keep the launcher and its data in a folder other people's accounts cannot write to. On Windows nothing checks who owns the marker, so anyone who can write there can change your profile.

## Going back

<!-- VERIFY: read from src/main/userDataMigration.ts (no marker means the default folder); not run by hand. -->

Close RiftLauncher and delete `RiftLauncher.portable`. The next start uses the profile in your user folder again, as you left it when you went portable. Changes made in portable mode stay in `RiftLauncherData` and are not copied back.

The installation pages for [Windows](../installation/windows.md#portable-data-folder) and [Linux](../installation/linux.md#portable-data-folder) go into more detail.
