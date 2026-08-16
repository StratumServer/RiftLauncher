import { loginToAccount, logoutOfAccount } from "../adapters/account"

/**
 * The preload-bridge surface SessionButton's login/logout flow needs.
 *
 * All the notification, dispatch and local-state handling around a login/logout attempt stays in
 * SessionButton itself; this only stops it from calling window.api directly.
 */
export function useAccountSession(): { login: typeof loginToAccount; logout: typeof logoutOfAccount } {
  return { login: loginToAccount, logout: logoutOfAccount }
}
