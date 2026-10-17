---
icon: mountain
description: Back up, restore, copy, move and delete the worlds of an Installation one at a time.
---

# Manage worlds

An [Installation backup](backups.md) saves the whole Installation. **Manage Worlds** works on one world at a time: back it up, restore it, copy or move it to another Installation, or delete it.

Open the **Installations** page and click the mountain button, **Manage Worlds**, on the Installation's row. The page lists the worlds in that Installation's `Saves` folder with their size, when each one last changed and how many backups it has. Each world's backups are listed under it.

## Back up a world

Click **Back up this world** on the world's row and confirm. The backup goes into a `Worlds` folder inside your Backups folder and shows up under the world.

Each world keeps as many backups as the Installation's **Backups max amount**, set on the Installation's edit page. When a new backup would go past that, the confirmation says how many of the oldest ones will be deleted. With the amount set to 0, no backup is made.

## Restore a world

Click **Restore** on one of the world's backups and confirm. It replaces that world's file and nothing else: the other worlds and files in `Saves` stay as they are.

The other buttons on a backup's row open its folder or delete that one backup. The launcher warns when the backup you delete is the last copy of the world.

## Copy or move a world to another Installation

1. Pick the other Installation in **Transfer to…** at the top of the page.
2. Click **Copy world** or **Move world** on the world's row and confirm.

**Move world** copies the world, then removes it from this Installation. If the other Installation already has a world with that name, the copy gets a number added to its name, so nothing is overwritten.

An Installation on another VS Version is marked **different version** in the list. A world opened with a newer Vintage Story version usually won't work with an older one. The launcher warns about that but lets you go ahead.

## Delete a world

Click the delete button on the world's row and type the world's name as it is listed. If the world has no backup yet, the launcher offers to make one first, and only deletes the world once that backup exists.

A deleted world that still has backups stays on the list, marked **backup only**, so you can still restore it.

Deleting a whole Installation with **Delete data** ticked also deletes its world backups, as it does its Installation backups.

## Close the game first

None of these changes can be made while that Installation is playing: close Vintage Story first. The other way round, **Play** is refused while a world is being backed up, restored, copied or moved, with "This Installation is busy managing a world. Try launching again in a moment."

### "This world is open in Vintage Story, or was not closed cleanly"

Vintage Story keeps an open world in two extra files next to it in `Saves`, `<world>.vcdbs-wal` and `<world>.vcdbs-shm`. While they are there, the launcher will not touch the world, because the `-wal` file can hold progress the world file does not have yet. Backing up, copying or moving the world without that file could lose the progress, and so could deleting the file.

The game removes both files when it closes the world normally. A crash or a power cut leaves them behind, and the launcher cannot tell that from a game that still has the world open, so it keeps refusing even after a reboot.

To clear it, open the world once in Vintage Story and quit normally. The game writes everything back into the world file and removes the two files, and the launcher accepts the change again. Do not delete either file by hand.
