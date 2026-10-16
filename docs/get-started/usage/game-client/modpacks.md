---
icon: box
description: Export an Installation's Mods as a modpack file, with its servers and mod configs if you want, and import one.
---

# Share a modpack

A modpack is a `.json` file that lists an Installation's Mods. Hand it to a friend and they can install the same set into one of their Installations in one go. It can also carry the Installation's saved servers and its mod config files, but only when you ask for them.

Everything here happens on the **Manage Mods** page of an Installation, under the **Modpack** button.

## Export a modpack

1. Open **Manage Mods** for the Installation you want to share.
2. If you want them in the pack, tick **Include servers** and **Include mod configs** beside the **Modpack** button. Each box only shows when there is something to include, and both start unticked every time you open the page.
3. Open **Modpack** and pick **Export Modpack** or **Export Server Modpack**.
4. Choose where to save the file.

**Export Modpack** writes every enabled Mod; disabled Mods stay out. **Export Server Modpack** writes only the server-side and universal Mods, for setting up a server.

### Mod configs

Mods write their settings into the `ModConfig` folder of the Installation. With **Include mod configs** ticked, the export first opens **Mod configs to export**, a list of every file in that folder.

Every file starts ticked. Untick the ones the pack should not carry, then choose **Export the chosen configs**, or **Export without configs** to leave them all out.

{% hint style="warning" %}
A mod config can hold server addresses, API keys and tokens. Anyone you hand the pack to can read every file you leave ticked, so look at what a file holds before you share it.
{% endhint %}

Some rows say under their name why a file cannot travel as it is. A file whose name Windows does not accept or holds hidden characters cannot be ticked, and neither can a link. Two files whose names only differ in upper and lower case start unticked: leave them out, or rename one in the `ModConfig` folder and export again.

## Import a modpack

1. Open **Manage Mods** for the Installation that should receive the Mods.
2. Open **Modpack**, then **Import Modpack**, and pick the `.json` file. Packs exported from RiftLauncher and from VS Launcher both work.
3. The launcher checks the mod database and lists every Mod with what will happen to it: a new install, an update, a downgrade, already installed, or not on the mod database. A Mod that is not on the mod database is usually a fork or a private build, and you install it by hand.
4. Confirm to install.

If the pack was made for another game version than this Installation, the list says so: some Mods may not work. If some Mods would be downgraded, it offers to take a backup first.

A modpack listed on the ModDB is a Mod like any other. Install it from the **Mods** page, not with **Import Modpack**.

### Servers and mod configs in a pack

When the pack carries servers, **Servers in this modpack** asks which ones to add once the Mods are done.

When it carries mod configs, **Mod configs in this modpack** lists each file:

- **This Installation has no file at this name**: the file is new here. It starts ticked.
- **Replaces yours**: the Installation already has a file at that name, maybe one you edited. It starts unticked, so nothing of yours is overwritten unless you tick it.

Choose **Write the chosen configs**, or **Write none of them** to skip them all. Only the ticked files are written.

### Getting your old config back

Before it replaces one of your files, RiftLauncher saves a copy under your Backups folder, in `Settings`, then a folder named after the Installation, then a dated `settings_` folder. An `applied.txt` file in it lists what was written. A file that was already identical to the pack's is left alone and not copied.

To undo a replacement, copy your file from that folder back into the Installation's `ModConfig` folder. RiftLauncher keeps as many of these folders per Installation as the Installation's **Backups max amount** and deletes the oldest.

Because of that copy, an Installation needs a Backups folder before a pack can write its configs. The configs are also not written while that Installation is playing: close the game first.
