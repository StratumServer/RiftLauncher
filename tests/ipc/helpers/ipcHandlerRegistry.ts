import type { IpcMainInvokeEvent } from "electron"

/**
 * Every `ipcMain.handle` registration captured since this module was last
 * (re)loaded, keyed by channel name.
 *
 * A handler file (src/ipc/handlers/*.ts) registers its channels once, at
 * module load, by calling `ipcMain.handle(channel, callback)`. A test's own
 * `electron` mock (whatever shape it needs beyond this) wires `ipcMain.handle`
 * to call {@link registerIpcHandler} instead of doing anything real with it;
 * the test then reads the callback back out with {@link getIpcHandler} and
 * invokes it directly with a fake event, the same way a real IPC dispatch
 * would.
 *
 * Deliberately its own module, with no `vi.mock` of its own: several test
 * files need their own differently-shaped `electron` mock (netHandlers needs
 * `net.request`, pathsHandlers needs `dialog`/`shell`/worker module paths,
 * ...), and only one `vi.mock("electron", ...)` factory can win per file.
 * Keeping the registry mock-free lets every one of those factories import and
 * call `registerIpcHandler` without fighting over which file "owns" the
 * `electron` mock.
 */
const ipcHandlers = new Map<string, (event: IpcMainInvokeEvent, ...args: never[]) => unknown>()

export function registerIpcHandler(channel: string, listener: (event: IpcMainInvokeEvent, ...args: never[]) => unknown): void {
  ipcHandlers.set(channel, listener)
}

/** Looks up a captured `ipcMain.handle` callback, failing loudly if the handler module was never imported. */
export function getIpcHandler<T = (event: IpcMainInvokeEvent, ...args: never[]) => unknown>(channel: string): T {
  const handler = ipcHandlers.get(channel)
  if (!handler) throw new Error(`No ipcMain.handle registered for channel "${channel}". Did the handler module get imported?`)
  return handler as T
}
