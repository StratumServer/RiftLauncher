# Manage worlds

Open the worlds button beside an Installation to see the `.vcdbs` worlds in its
`Saves` folder. The list shows each world's size, last modification time, and
the number of launcher backups that exist for it.

You can back up, restore, delete, copy, or move one world at a time. Copying or
moving to another Installation adds a numeric suffix when the destination
already has a world with that name. Transfers between different Vintage Story
versions are allowed but show a warning.

World changes are disabled while either Installation is playing. The launcher
also refuses to change a world while Vintage Story has its SQLite `-wal` or
`-shm` sidecar open; close the game first so no recent save data is lost.

World backups are stored beneath the configured Backups folder and survive
deleting the live world. A restore replaces only the selected `.vcdbs` file;
other files in `Saves` are left untouched.
