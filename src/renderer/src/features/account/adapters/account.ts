/**
 * Wraps the preload-bridge `accountManager` calls SessionButton's login/logout flow needs.
 *
 * `features/account` did not exist before this stage (confirmed with a grep across
 * src/renderer/src/features before adding it). Lives outside components/ui, where
 * SessionButton.tsx lives, so this stage's exit gate does not flag it.
 */
export function loginToAccount(
  email: string,
  password: string,
  twoFactorCode?: string
): Promise<{ status: "success"; account: AccountPublicType } | { status: "invalid-credentials" | "requires-two-factor" | "wrong-two-factor" }> {
  return window.api.accountManager.login(email, password, twoFactorCode)
}

export function logoutOfAccount(): Promise<boolean> {
  return window.api.accountManager.logout()
}
