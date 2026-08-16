/**
 * The account parsers moved to `src/domain/account/credentials.ts`, where they
 * sit next to the login interpretation that uses them. They were already pure,
 * so nothing about them changed. This file stays as the import path the main
 * process code already knows.
 */

export { parseLegacyAccount, parseLoginAccount, parseStoredSecrets, toPublicAccount } from "../domain/account/credentials"
export type { AccountCredentials, AccountSecrets } from "../domain/account/credentials"
