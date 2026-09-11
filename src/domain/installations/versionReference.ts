export type InstallationVersionStatus = "linked" | "unlinked" | "missing" | "unset"

/** Describes how an Installation's stored VS Version reference resolves today. */
export function getInstallationVersionStatus(
  installation: Pick<InstallationType, "version" | "gameVersionId">,
  gameVersions: ReadonlyArray<Pick<GameVersionType, "id" | "version">>
): InstallationVersionStatus {
  if (!installation.version) return "unset"
  if (gameVersions.some((gameVersion) => gameVersion.id === installation.gameVersionId)) return "linked"
  return gameVersions.some((gameVersion) => gameVersion.version === installation.version) ? "unlinked" : "missing"
}
