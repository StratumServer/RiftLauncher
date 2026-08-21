import Logger from "electron-log"

// The node and mocked-electron harnesses mock electron but not electron-log, so
// without the real main process's resolvePathFn its file transport falls back to
// the developer's real home directory (~/.config/riftlauncher/logs) and every
// logMessage in a test appends there (#187). Tests keep the console transport
// for debugging; the file transport is what must never fire.
Logger.transports.file.level = false
