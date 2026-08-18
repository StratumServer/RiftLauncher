using System.IO.Compression;

namespace RiftLauncher.Core.Domain.Installations;

public sealed record BackupRecord(string Id, long Date, string Path);

public sealed record InstallationBackupSnapshot(
    string Id,
    string Name,
    string Path,
    int BackupsLimit,
    int CompressionLevel,
    IReadOnlyList<BackupRecord> Backups,
    bool IsBackingUp,
    bool IsPlaying,
    bool IsRestoringBackup);

public enum MakeBackupFailure
{
    InstallationBusy,
    InstallationPlaying,
    RestoreInProgress,
    InstallationPathMissing,
    NoBackupsFolder,
    BackupsDisabled,
    PruneFailed,
    CompressFailed
}

public sealed record MakeBackupResult(bool Ok, BackupRecord? Backup = null, IReadOnlyList<string>? DeletedBackupIds = null, MakeBackupFailure? Reason = null)
{
    public static MakeBackupResult Success(BackupRecord backup, IReadOnlyList<string> deletedIds) =>
        new(true, backup, deletedIds);
    public static MakeBackupResult Failure(MakeBackupFailure reason, IReadOnlyList<string>? deletedIds = null) =>
        new(false, Reason: reason, DeletedBackupIds: deletedIds ?? []);
}

public sealed record MakeBackupInput(InstallationBackupSnapshot Installation, string BackupsFolder);

public static class BackupService
{
    public static async Task<MakeBackupResult> MakeBackupAsync(
        MakeBackupInput input,
        IProgress<double>? progress = null,
        CancellationToken ct = default)
    {
        var installation = input.Installation;

        if (installation.IsBackingUp)
            return MakeBackupResult.Failure(MakeBackupFailure.InstallationBusy);
        if (installation.IsPlaying)
            return MakeBackupResult.Failure(MakeBackupFailure.InstallationPlaying);
        if (installation.IsRestoringBackup)
            return MakeBackupResult.Failure(MakeBackupFailure.RestoreInProgress);

        if (!Directory.Exists(installation.Path))
            return MakeBackupResult.Failure(MakeBackupFailure.InstallationPathMissing);
        if (string.IsNullOrEmpty(input.BackupsFolder))
            return MakeBackupResult.Failure(MakeBackupFailure.NoBackupsFolder);
        if (installation.BackupsLimit <= 0)
            return MakeBackupResult.Failure(MakeBackupFailure.BackupsDisabled);

        var deletedIds = new List<string>();

        var remaining = installation.Backups.Count;
        while (remaining > 0 && remaining >= installation.BackupsLimit)
        {
            var oldest = installation.Backups[remaining - 1];
            try
            {
                if (File.Exists(oldest.Path))
                    File.Delete(oldest.Path);
                deletedIds.Add(oldest.Id);
                remaining--;
            }
            catch
            {
                return MakeBackupResult.Failure(MakeBackupFailure.PruneFailed, deletedIds);
            }
        }

        var date = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var cleanName = Naming.CleanFolderName(installation.Name);
        if (string.IsNullOrEmpty(cleanName))
            cleanName = installation.Id[..Math.Min(8, installation.Id.Length)];
        var dateStamp = Naming.FormatTimestampForFilename(date);
        var fileName = $"{cleanName}_{dateStamp}.zip";

        var outputFolder = System.IO.Path.Combine(input.BackupsFolder, InstallationConstants.BackupSubfolder, cleanName);
        Directory.CreateDirectory(outputFolder);
        var archivePath = System.IO.Path.Combine(outputFolder, fileName);

        try
        {
            await Task.Run(() =>
            {
                ZipFile.CreateFromDirectory(installation.Path, archivePath, CompressionLevel.Optimal, includeBaseDirectory: false);
            }, ct);

            var backup = new BackupRecord(Guid.NewGuid().ToString(), date, archivePath);
            return MakeBackupResult.Success(backup, deletedIds);
        }
        catch
        {
            return MakeBackupResult.Failure(MakeBackupFailure.CompressFailed, deletedIds);
        }
    }

    public static async Task<bool> RestoreBackupAsync(string archivePath, string installationPath, CancellationToken ct = default)
    {
        if (!File.Exists(archivePath))
            return false;

        try
        {
            if (Directory.Exists(installationPath))
                Directory.Delete(installationPath, recursive: true);
            Directory.CreateDirectory(installationPath);

            await Task.Run(() =>
            {
                ZipFile.ExtractToDirectory(archivePath, installationPath, overwriteFiles: true);
            }, ct);

            return true;
        }
        catch
        {
            return false;
        }
    }
}
