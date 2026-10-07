# Manage worlds

Open the worlds button beside an Installation to see the `.vcdbs` worlds in its
`Saves` folder. The list shows each world's size, last modification time, and
the number of launcher backups that exist for it.

You can back up, restore, delete, copy, or move one world at a time. Copying or
moving to another Installation adds a numeric suffix when the destination
already has a world with that name. Transfers between different Vintage Story
versions are allowed but show a warning.

The launcher refuses every world change while Vintage Story is running in the
same session: close the game first. A session already closed before the launcher
restarted is not tracked, so the launcher also refuses to change a world while
its SQLite journal files, `<world>.vcdbs-wal` or `<world>.vcdbs-shm`, are in
`Saves` beside it. Both guards depend on the live `Saves` folder being free of
the game's own locks.

Those two files hold the latest changes the game made to the world, and a
backup, a copy or a move that leaves them out would lose those changes, so the
launcher refuses until they are gone. A crash or a power cut leaves them behind
too, and the launcher cannot tell that from a game that still has the world
open: it can refuse with the game closed, even after a reboot. To clear it, open
the world once in Vintage Story and quit normally. The files go away when the
game opens the world again and closes it cleanly, and then the launcher accepts
the change again. Do not delete the `-wal` or `-shm` file yourself, because
whatever the world file does not hold yet would be lost with it.

World backups are stored beneath the configured Backups folder and survive
deleting the live world. Each world retains up to the Installation's configured
backup limit, pruning older backups when a new one is created. Individual
backups can also be deleted directly from their row. A restore replaces only
the selected `.vcdbs` file; other files in `Saves` are left untouched.
