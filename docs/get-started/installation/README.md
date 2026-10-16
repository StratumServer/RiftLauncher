---
description: Don't have RiftLauncher installed yet?
---

# ⬇️ Installation

Installing RiftLauncher is easy.

{% hint style="info" %}
Everything you download is named after RiftLauncher: `riftlauncher-X.X.X-setup.exe` on Windows and `riftlauncher-X.X.X.AppImage`, `.deb`, `.rpm` or `.pacman` on Linux. The installed app, its shortcut and its window all read **RiftLauncher**, and it keeps its own data folder next to VS Launcher's rather than inside it. If you already used VS Launcher, RiftLauncher copies its settings and installation icons over on first launch and leaves the VS Launcher folder untouched, so you can go back to it whenever you want. Legacy folders that are symbolic links or junctions are not copied. On Linux and macOS, folders owned by another user are not copied either. If the copy fails, or is skipped because of an unsupported folder or ownership issue, RiftLauncher starts on an empty profile and tells you so. It tries the copy again at each start as long as you have not changed anything in RiftLauncher, so resolve the link or permissions and launch again. In portable mode, a failed copy instead stops RiftLauncher from starting and shows the reason, unless the normal profile was already left empty by a failed copy: then it starts on an empty portable profile and tries again.
{% endhint %}

Depending on the operating system you use, the process changes a bit, so we are going to separate the explanation into **Windows**, **Linux** and **MacOS**.

{% content-ref url="windows.md" %}
[windows.md](windows.md)
{% endcontent-ref %}

{% content-ref url="linux.md" %}
[linux.md](linux.md)
{% endcontent-ref %}

{% content-ref url="macos.md" %}
[macos.md](macos.md)
{% endcontent-ref %}
