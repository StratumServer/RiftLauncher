/**
 * Whether the launcher may keep a session on a machine with no system keyring.
 *
 * safeStorage always encrypts, but on Linux with no keyring it falls back to a store Chromium
 * calls `basic_text`, whose key is compiled into the binary. A session sealed with a key every
 * copy of the launcher already knows is a session any program running as the player can read, so
 * the store refuses it and the session is held for the running process only.
 *
 * Some people would rather have the convenience anyway: a single-user machine, a headless desktop
 * with no wallet daemon, a distribution where setting one up is more work than it is worth. That
 * is a real answer, and it is theirs to give, so it is a setting. It is off in every config that
 * has not been asked, it is never turned on by anything but the player, and the sentence under it
 * says plainly what it costs.
 *
 * Chromium picks its password store while the process is starting, long before any config read
 * the app does, so the setting can only be honoured by the launch after it is changed. That is
 * why the toggle says a restart is needed rather than pretending to take effect at once.
 */

/** Off. A session sealed with a key that ships in the binary is not something to opt anyone into. */
export const DEFAULT_ALLOW_BASIC_SESSION_STORE = false

/**
 * The value for Chromium's `--password-store` switch, or null when the launcher must not ask for
 * one and should leave the platform to choose.
 *
 * Linux-only because the switch is: macOS and Windows have a keychain that is always there, and
 * asking them for the basic store would trade real protection for nothing.
 */
export function basicPasswordStoreSwitch(platform: string, allowBasicSessionStore: boolean): string | null {
  return platform === "linux" && allowBasicSessionStore ? "basic" : null
}
