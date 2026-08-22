/**
 * Wraps the preload-bridge `accountManager` calls SessionButton's login/logout flow needs.
 *
 * Lives outside components/ui, where SessionButton.tsx lives, because nothing under
 * src/renderer/src/components may touch the preload bridge directly.
 */
export function loginToAccount(email: string, password: string, twoFactorCode?: string): Promise<AccountLoginResult> {
  return window.api.accountManager.login(email, password, twoFactorCode)
}

export function logoutOfAccount(): Promise<boolean> {
  return window.api.accountManager.logout()
}
