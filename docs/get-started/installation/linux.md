---
description: If you're using Linux follow this guide!
icon: linux
---

# Linux

RiftLauncher works on ANY Linux distro thanks to the AppImage compilation we're using.

Installing it on Linux is as easy as downloading the AppImage and double clicking it.... that's it. Let's get started:

{% hint style="success" %}
If you're using Arch Linux or a derivative there is a `.pacman` package on the releases page. Community AUR packages are welcome. [`riftlauncher-bin`](https://aur.archlinux.org/packages/riftlauncher-bin) is one, maintained outside Stratum: we do not build or support it. If you want to package RiftLauncher yourself, say hi on the [Stratum Discord server](https://discord.gg/vQm6z2urZs) so we can coordinate. There is no distro repository, so your first install comes from the releases page or from a community AUR package.
{% endhint %}

{% hint style="warning" %}
**AUR installs and the built-in updater.** The built-in updater runs on any `.pacman` install: it downloads the release `.pacman` and installs it through pacman, using the package marker electron-builder writes next to the app. On an AUR install that puts the launcher and your package manager in charge of the same files, so update an AUR install through your package manager: `yay -Syu` or `paru -Syu`. The maintainer of `riftlauncher-bin` reports on [issue #262](https://github.com/StratumServer/RiftLauncher/issues/262) that it updates cleanly that way. If you maintain an AUR package, document the update path in its description.
{% endhint %}

{% stepper %}
{% step %}
**Go to the** [**GitHub Releases Page**](https://github.com/StratumServer/RiftLauncher/releases)

On that page you'll see all the available versions to download.
{% endstep %}

{% step %}
**Download the Linux version**

On the releases page, the first version is always the latest one. There you'll see a table with the different files to download. The one you want is `riftlauncher-X.X.X.AppImage`, where `X.X.X` is the version number.

{% hint style="info" %}
Every release ships four Linux builds: `riftlauncher-X.X.X.AppImage`, `.deb`, `.x86_64.rpm` and `.pacman`. There is no Flatpak build; the runtimes it needs aren't available on our build machines.

If you prefer a packaged install over the AppImage, install the `.deb`, `.rpm` or `.pacman` once and then skip steps 3, 4 and 5:

```sh
sudo dpkg -i riftlauncher-X.X.X.deb
# or
sudo rpm -i riftlauncher-X.X.X.x86_64.rpm
# or
sudo pacman -U riftlauncher-X.X.X.pacman
```

From there just open it like any other app. All three update themselves the same way the AppImage does, except that replacing an installed package needs elevated privileges, so RiftLauncher will show a system password prompt (`pkexec`, `sudo` or similar) each time it applies an update.
{% endhint %}
{% endstep %}

{% step %}
**Move the AppImage to an accesible location**

For example the Desktop, the you'll be able to open it whenever you want.

{% hint style="warning" %}
Some users reported that AppImage Launcher is breaking automaitc updates so if you want to use it make sure to download the latest RiftLauncher version when it's published!
{% endhint %}
{% endstep %}

{% step %}
**Add execution persmissions**

This should be done by default by sometimes you've to manually do it.

```sh
chmod +x ./riftlauncher-X.X.X.AppImage
```

{% endstep %}

{% step %}
**Open RiftLauncher**

Double click the AppImage and that's it, ready to use!
{% endstep %}

{% step %}
**Install Dependencies**

RiftLauncher does not need any dependecy to work but Vintage Story does so follow the next steps.
{% endstep %}
{% endstepper %}

---

## Vintage Story Dependencies

RiftLauncher does not need any dependencies to work, but Vintage Story does. This process isn't automated on game launch, since Linux has too many distros to personalize it for all of them, so you'll have to do it manually.

To help you with this process we've made a few guide explaining how to install every dependency needed on the most popular Linux distros.

The biggest one is .NET, and it belongs to the game rather than to the launcher: RiftLauncher runs fine without it, Vintage Story does not start at all. Which major version you need depends on the game version you play (7, 8 or 10), so installing several side by side is normal, and a version that used to launch can stop launching once you move to a newer game build.

### Debian, Ubuntu and their derivatives

{% stepper %}
{% step %}

#### Install .NET 7, 8 and 10

```sh
wget https://dot.net/v1/dotnet-install.sh -O dotnet-install.sh
```

```sh
chmod +x ./dotnet-install.sh
```

```sh
sudo ./dotnet-install.sh --channel 7.0 --install-dir /usr/lib/dotnet
```

```sh
sudo ./dotnet-install.sh --channel 8.0 --install-dir /usr/lib/dotnet
```

```sh
sudo ./dotnet-install.sh --channel 10.0 --install-dir /usr/lib/dotnet
```

`dotnet-install.sh` only adds `/usr/lib/dotnet` to the current shell's `PATH`, and that's gone the moment you close the terminal. It doesn't matter anyway: Vintage Story starts through its own .NET apphost, not through a shell, and the apphost never looks at `PATH`. It checks `DOTNET_ROOT` first, then the location registered in `/etc/dotnet/install_location`, then falls back to its compiled-in default (`/usr/share/dotnet/` on Linux x64). `dotnet-install.sh` sets none of those, so register the install yourself:

```sh
echo /usr/lib/dotnet | sudo tee /etc/dotnet/install_location
```

This is the file the game's .NET host actually reads, so without it the runtimes you just installed stay invisible to Vintage Story.

```sh
sudo ln -s /usr/lib/dotnet/dotnet /usr/bin/dotnet
```

This just puts `dotnet` itself on your `PATH`, which you need for the check below and for any other tool that expects `dotnet` to exist.

**Check it**

```sh
dotnet --list-runtimes
```

should list a `Microsoft.NETCore.App` entry for whichever major version, 7, 8 or 10, the game version you play needs.

{% hint style="warning" %}
If RiftLauncher says a .NET runtime is missing and a copy of the game ran fine before, that older copy most likely shipped its own runtime alongside the game files. The versions RiftLauncher lists as installed come from the system-wide .NET install above, not from a bundled copy, so the two don't tell you the same thing. The exact locations the .NET host searched and didn't find anything are printed in `verbose.log` if you want to see them. If your runtime lives somewhere `/etc/dotnet/install_location` doesn't point to, you can also set `DOTNET_ROOT` for a single Installation from its **ENV variables** field in the Advanced section, instead of changing the system-wide registration.
{% endhint %}

{% endstep %}

{% step %}

#### Install your graphics driver

You'll have to look up how to do this for your graphics card and your Linux distribution as the combinations are almost endless!
{% endstep %}

{% step %}

#### Install OpenAL and mono-complete

```sh
sudo apt install libopenal-dev mono-complete
```

{% endstep %}

{% step %}

#### Fix RAM limits

```sh
sudo sysctl -w vm.max_map_count=262144
```

{% endstep %}
{% endstepper %}

### Arch and its derivatives

{% stepper %}
{% step %}

#### Install your graphics driver

You'll have to look up how to do this for your graphics card and your Linux distribution as the combinations are almost endless!
{% endstep %}

{% step %}

#### Install all the dependencies

```sh
sudo pacman -S dotnet-runtime-7.0 dotnet-runtime-8.0 dotnet-runtime glibc openal opengl-driver mono
```

Unlike the script-based install above, there's nothing to register by hand here: Arch's `dotnet-runtime` packages write `/etc/dotnet/install_location` themselves as part of installation.

{% endstep %}
{% endstepper %}

### SteamOS

{% stepper %}
{% step %}

#### Disable readonly mode

SteamOS is protected so you can't make changes by accident. To install the dependencies you need to disable this:

```sh
sudo steamos-readonly disable
```

{% endstep %}

{% step %}

#### Configure pacman

Sometimes you'll need to do some steps to configure everything:

```sh
sudo pacman-key --init
sudo pacman-key --populate archlinux
sudo pacman-key --populate holo
```

{% endstep %}

{% step %}

#### Install all the dependencies

```sh
sudo pacman -S dotnet-runtime-7.0 dotnet-runtime-8.0 dotnet-runtime glibc openal opengl-driver mono
```

{% endstep %}

{% step %}

#### Enable readonly mode again

```sh
sudo steamos-readonly enable
```

{% endstep %}
{% endstepper %}

{% hint style="info" %}
This sequence is inherited from the original VS Launcher docs, where it came from a user who got it working on their own machine. Nobody on the current team has a Steam Deck, so it has never been reproduced or verified step by step. If you run it and something is off, a report on the [Stratum Discord server](https://discord.gg/vQm6z2urZs) would be very welcome.
{% endhint %}

### Nixos

{% stepper %}
{% step %}

#### Enable appimages, and add dotnet as an extra package

Appimages require a couple of options to be enabled in order to load, and they cannot see system libraries such as dotnet. Simply add this to your config to enable appimage support, and reveal the missing dotnet library:

```sh
  programs.appimage.enable = true;
  programs.appimage.binfmt = true;
  programs.appimage.package = pkgs.appimage-run.override { extraPkgs = pkgs: [
    pkgs.dotnet-runtime
  ]; };
```

{% endstep %}
{% endstepper %}

{% hint style="info" %}
Note, that this will enable appimages system-wide, and all appimages will have dotnet available to them.
{% endhint %}

---

## Session storage and keyrings

When you log in, RiftLauncher hands your session to the desktop's own keyring instead of keeping it in a file of its own. On Linux that is GNOME Keyring or KWallet, reached through `libsecret`. The `.deb` and `.rpm` packages already depend on `libsecret`, and the `.deb` recommends `gnome-keyring` for desktops that have no wallet of their own, so most installs need nothing here.

If no keyring answers, Electron falls back to a store that seals the session with a key built into the launcher, which means any program running as you can read it. RiftLauncher refuses that store by default. You can still log in and play: the session is kept in memory for as long as the launcher is open, and you log in again next time. The launcher says so when it happens.

### GNOME, Cinnamon, Budgie and friends

GNOME Keyring is installed and unlocked with your session by default, so there is nothing to do. If you removed it, `sudo apt install gnome-keyring` or `sudo dnf install gnome-keyring` puts it back.

### KDE Plasma

KWallet is installed with Plasma but it can be switched off, and a wallet that does not exist is the same as no keyring at all. Open **System Settings**, go to **KDE Wallet**, tick **Enable the KDE wallet subsystem**, and create a wallet if there is none. Blowfish and GPG both work. If you give the wallet a password, you will be asked for it once per session, the first time something reads it.

`kwalletmanager` is worth installing if you want to look at what is stored: it lists the wallets, shows the entries in them, and can create a wallet without going through System Settings.

### Other desktops, tiling window managers, and machines with no desktop at all

Sway, i3, Hyprland and the like start nothing of this sort on their own. Install `gnome-keyring` and have your session start the daemon, for example by launching your window manager through `dbus-run-session -- gnome-keyring-daemon --start --components=secrets` or by adding the daemon to whatever your session already starts. What matters is that the daemon is running and unlocked in the same session as the launcher.

### If you would rather not have a keyring

There is a setting for it. In **Settings**, turn on **Remember the session without a system keyring**, then restart RiftLauncher: Chromium picks its storage as it starts, so the setting only takes effect on the next launch.

Be clear about the trade. With that setting on, your session is written to disk sealed with a key that ships inside the launcher, the same key in every copy of it. Anyone who can read your files, and any program running under your account, can read the session and use it as you. On a machine you alone use, that may well be a fair price for not logging in again every time. On a shared or managed machine it is not. That is why the setting is off until you turn it on.

---

## Where RiftLauncher keeps its data

Every Linux build stores its config, the list of your game versions and the list of your Installations in `/home/username/.config/RiftLauncher/`. Switching between the AppImage and a packaged build changes nothing about that, so you keep everything either way.

If you're coming from VS Launcher, its own folder is `/home/username/.config/VSLauncher/` and RiftLauncher never writes to it. The first time RiftLauncher starts it copies VS Launcher's `config.json` and its installation icons across into its own folder, so both launchers keep working and neither can overwrite the other's settings.

---

{% hint style="info" %}
If you find any issue report it on the [GitHub Issue Tracker](https://github.com/StratumServer/RiftLauncher/issues) and if you need help ask us on the [Stratum Discord server](https://discord.gg/vQm6z2urZs), the [GitHub Discussions](https://github.com/StratumServer/RiftLauncher/discussions) or the [Official Vintage Story Discord Server](https://discord.com/channels/302152934249070593/1314991001571557488).
{% endhint %}
