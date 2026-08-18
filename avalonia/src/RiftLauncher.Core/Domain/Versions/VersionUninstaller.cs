namespace RiftLauncher.Core.Domain.Versions;

public sealed record GameVersionSnapshot(string Version, string Path, bool IsPlaying, bool IsDeleting);

public enum UninstallVersionFailure
{
    VersionPlaying,
    VersionBusy,
    VersionInUse,
    FileDeleteFailed
}

public sealed record UninstallVersionResult(bool Ok, UninstallVersionFailure? Reason = null)
{
    public static UninstallVersionResult Success() => new(true);
    public static UninstallVersionResult Failure(UninstallVersionFailure reason) => new(false, reason);
}

public sealed record UninstallVersionInput(
    GameVersionSnapshot Version,
    IReadOnlyList<string> UsedByInstallations,
    bool ConfirmedInUse);

public static class VersionUninstaller
{
    public static async Task<UninstallVersionResult> UninstallAsync(UninstallVersionInput input)
    {
        if (input.Version.IsPlaying)
            return UninstallVersionResult.Failure(UninstallVersionFailure.VersionPlaying);
        if (input.Version.IsDeleting)
            return UninstallVersionResult.Failure(UninstallVersionFailure.VersionBusy);
        if (input.UsedByInstallations.Count > 0 && !input.ConfirmedInUse)
            return UninstallVersionResult.Failure(UninstallVersionFailure.VersionInUse);

        try
        {
            if (Directory.Exists(input.Version.Path))
                Directory.Delete(input.Version.Path, recursive: true);
            return UninstallVersionResult.Success();
        }
        catch
        {
            return UninstallVersionResult.Failure(UninstallVersionFailure.FileDeleteFailed);
        }
    }
}
