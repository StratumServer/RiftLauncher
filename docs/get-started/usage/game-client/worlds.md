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
its SQLite files, `<world>.vcdbs-wal` or `<world>.vcdbs-shm`, are in
`Saves` beside it. Both guards depend on the live `Saves` folder being free of
the game's own locks.

The two files play different roles. The `-wal` file is SQLite's write-ahead log:
it can hold committed changes that have not been written into the world file
yet, so a backup, a copy or a move that leaves it out can lose them, and so can
deleting it. The `-shm` file is only an index of the log that SQLite rebuilds on
its own. It belongs with the `-wal` file all the same, so the launcher refuses
while either one is there. A crash or a power cut leaves them behind too, and
the launcher cannot tell that from a game that still has the world open: it can
refuse with the game closed, even after a reboot. To clear it, open the world
once in Vintage Story and quit normally. The game folds the log back into the
world file and removes both files when it closes cleanly, and then the launcher
accepts the change again. Do not delete either file by hand.

World backups are stored beneath the configured Backups folder and survive
deleting the live world. Each world retains up to the Installation's configured
backup limit, pruning older backups when a new one is created. Individual
backups can also be deleted directly from their row. A restore replaces only
the selected `.vcdbs` file; other files in `Saves` are left untouched.
