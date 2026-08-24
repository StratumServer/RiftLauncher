---
description: If you're using Linux follow this guide!
icon: linux
---

# Linux

RiftLauncher works on ANY Linux distro thanks to the AppImage compilation we're using.

Installing it on Linux is as easy as downloading the AppImage and double clicking it.... that's it. Let's get started:

{% hint style="success" %}
If you're using Arch Linux or a derivative there is a `.pacman` package on the releases page you can install with `sudo pacman -U riftlauncher-X.X.X.pacman`. There is no RiftLauncher package on the AUR: the `vs-launcher` AUR package belongs to the archived original project and does not track our releases.
{% endhint %}

{% stepper %}
{% step %}
**Go to the** [**GitHub Releases Page**](https://github.com/StratumServer/RiftLauncher/releases)

On that page you'll see all the available versions to download.
{% endstep %}

{% step %}
**Download the Linux version**

On the releases page, the first version is always the latest one. There you'll see a table with the different files to download. The one you want is `riftlauncher-X.X.X.AppImage`, where `X.X.X` is the version number:

<div align="left"><img src="../../.gitbook/assets/imagen (1).png" alt=""></div>

{% hint style="info" %}
Every release ships four Linux builds: `riftlauncher-X.X.X.AppImage`, `.deb`, `.x86_64.rpm` and `.pacman`. There is no Flatpak build; the runtimes it needs aren't available on our build machines.

If you prefer a packaged install over the AppImage, install the `.deb`, `.rpm` or `.pacman` with your usual package tool and then skip steps 3, 4 and 5. Just open it like any other app. All three update themselves the same way the AppImage does, except that replacing an installed package needs elevated privileges, so RiftLauncher will show a system password prompt (`pkexec`, `sudo` or similar) each time it applies an update.
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
This SteamOS guide was sent by an user that got it working with this. I don't know what each stem does and didn't tested it.
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

## Where RiftLauncher keeps its data

Every Linux build stores its config, the list of your game versions and the list of your Installations in `/home/username/.config/RiftLauncher/`. Switching between the AppImage and a packaged build changes nothing about that, so you keep everything either way.

If you're coming from VS Launcher, its own folder is `/home/username/.config/VSLauncher/` and RiftLauncher never writes to it. The first time RiftLauncher starts it copies VS Launcher's `config.json` and its installation icons across into its own folder, so both launchers keep working and neither can overwrite the other's settings.

---

{% hint style="info" %}
If you find any issue report it on the [GitHub Issue Tracker](https://github.com/StratumServer/RiftLauncher/issues) and if you need help ask us on the [GitHub Discussions](https://github.com/StratumServer/RiftLauncher/discussions) or on the [Official Vintage Story Discord Server](https://discord.com/channels/302152934249070593/1314991001571557488).
{% endhint %}
