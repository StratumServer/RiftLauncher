---
icon: check
description: >-
  If you've the game already installed follow this guide. If don't do to the
  next one.
---

# Vintage Story is already installed

If you already have the game installed you just need to tell RiftLauncher where it is. To do this just follow the next steps:

{% stepper %}
{% step %}

### Add the VS Version

**VS Versions** are the base game files like assets, code, executables... By default this ones can be found on the next folder:

- **Windows:** `C:/Users/YourUsername/AppData/Roaming/Vintagestory`
- **Linux:** The folder where you extracted the `.tar.gz` or `/home/YourUsername/.local/share/Vintagestory/`

{% hint style="warning" %}
Don't confuse it with `VintagestoryData`, that's the Installation(data) folder.
{% endhint %}

{% embed url="https://www.youtube.com/watch?v=G61Li2xChJg" %}
Add an already installed Vintage Story Version | VS Launcher Guides
{% endembed %}
{% endstep %}

{% step %}

### Add the Installation

If you already played the game before then you'll have a data folder with all your worlds, configs, maps, mods... if don't the continue the guide [here](install-vintage-story.md#add-an-installation). By default this ones can be found on the next folder:

- **Windows:** `C:/Users/YourUsername/AppData/Roaming/VintagestoryData`
- **Linux:** `/home/YourUsername/.config/VintagestoryData/`

{% hint style="warning" %}
Don't confuse it with `Vintagestory`, that's the Version(base game files) folder.
{% endhint %}

{% embed url="https://www.youtube.com/watch?v=iODL3QmheL0" %}
Add an already created Installation | VS Launcher Guides
{% endembed %}
{% endstep %}

{% step %}

### Update `modPaths` and `ModPaths`

The `clientsettings.json` and `serverconfig.json` files in a copied installation may still point the game at the mods folder's old location.

RiftLauncher handles `modPaths` in `clientsettings.json` for you. Every time you launch the game, it checks that list, and when it is still the pair the game writes by itself (`Mods` plus the full path of a data folder's `Mods` subfolder) and that full path sits outside the installation, it points it at the installation's own `Mods` folder instead. A list you have edited yourself, an extra shared mods folder for instance, is left exactly as you wrote it: the launcher only notes in its log that it found one and changed nothing.

`ModPaths` in `serverconfig.json` is still a manual edit. If a server installation can't find its mods after the move, open that file and update the folder's location yourself.

{% endstep %}

{% step %}

### Play the game

Check the next guide on how to play Vintage Story:

[play-vintage-story.md](play-vintage-story.md "mention")
{% endstep %}
{% endstepper %}
