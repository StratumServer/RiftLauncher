namespace RiftLauncher.Core.Domain.Installations;

public sealed record InstallationDeleteSnapshot(
    string Path,
    IReadOnlyList<string> BackupPaths,
    bool IsPlaying,
    bool IsBackingUp,
    bool IsRestoringBackup);

public enum DeleteInstallationFailure
{
    InstallationPlaying,
    InstallationBusy,
    RestoreInProgress,
    DataDeleteFailed
}

public sealed record DeleteInstallationResult(bool Ok, IReadOnlyList<string> FailedBackupPaths, DeleteInstallationFailure? Reason = null)
{
    public static DeleteInstallationResult Success(IReadOnlyList<string>? failedPaths = null) =>
        new(true, failedPaths ?? []);
    public static DeleteInstallationResult Failure(DeleteInstallationFailure reason) =>
        new(false, [], reason);
}

public sealed record DeleteInstallationInput(InstallationDeleteSnapshot Installation, bool DeleteData);

public static class InstallationDeleter
{
    public static async Task<DeleteInstallationResult> DeleteAsync(DeleteInstallationInput input)
    {
        var installation = input.Installation;

        if (installation.IsPlaying)
            return DeleteInstallationResult.Failure(DeleteInstallationFailure.InstallationPlaying);
        if (installation.IsBackingUp)
            return DeleteInstallationResult.Failure(DeleteInstallationFailure.InstallationBusy);
        if (installation.IsRestoringBackup)
            return DeleteInstallationResult.Failure(DeleteInstallationFailure.RestoreInProgress);

        if (!input.DeleteData)
            return DeleteInstallationResult.Success();

        try
        {
            if (Directory.Exists(installation.Path))
                Directory.Delete(installation.Path, recursive: true);
            else
                return DeleteInstallationResult.Failure(DeleteInstallationFailure.DataDeleteFailed);
        }
        catch
        {
            return DeleteInstallationResult.Failure(DeleteInstallationFailure.DataDeleteFailed);
        }

        var failedPaths = new List<string>();
        foreach (var backupPath in installation.BackupPaths)
        {
            try
            {
                if (File.Exists(backupPath))
                    File.Delete(backupPath);
            }
            catch
            {
                failedPaths.Add(backupPath);
            }
        }

        return DeleteInstallationResult.Success(failedPaths);
    }
}
