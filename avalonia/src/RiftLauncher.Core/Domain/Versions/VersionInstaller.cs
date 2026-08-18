namespace RiftLauncher.Core.Domain.Versions;

public sealed record GameVersionDownload(string Url, string FileName);

public sealed record GameVersionDownloads(
    GameVersionDownload Win32,
    GameVersionDownload Darwin,
    GameVersionDownload Linux);

public sealed record DownloadableGameVersion(string Version, GameVersionDownloads Downloads);

public enum InstallVersionFailure
{
    VersionAlreadyInstalled,
    FolderInUse,
    NoDownloadForOs,
    DownloadFailed,
    UnpackFailed,
    GameExecutableMissing
}

public sealed record InstallVersionResult(bool Ok, string? Path = null, InstallVersionFailure? Reason = null)
{
    public static InstallVersionResult Success(string path) => new(true, path);
    public static InstallVersionResult Failure(InstallVersionFailure reason) => new(false, Reason: reason);
}

public sealed record InstallVersionInput(
    string Platform,
    DownloadableGameVersion Version,
    string TargetFolder,
    IReadOnlyList<string> InstalledVersions,
    IReadOnlyList<string> FoldersInUse);

public interface IInstallVersionEvents
{
    void OnRegistered() { }
    void OnInstalled() { }
    void OnDiscarded(InstallVersionFailure reason) { }
}

public interface IDownloader
{
    Task<DownloadResult> DownloadAsync(string url, string outputFolder, string fileName,
        IProgress<double>? progress = null, CancellationToken ct = default);
}

public sealed record DownloadResult(bool Ok, string? FilePath = null, string? Error = null);

public interface IUnpacker
{
    Task<UnpackResult> ExtractArchiveAsync(string sourcePath, string outputFolder,
        IProgress<double>? progress = null, CancellationToken ct = default);
    Task<UnpackResult> RunInstallerAsync(string sourcePath, string outputFolder,
        CancellationToken ct = default);
}

public sealed record UnpackResult(bool Ok, string? Error = null);

public static class VersionInstaller
{
    public static async Task<InstallVersionResult> InstallAsync(
        InstallVersionInput input,
        IDownloader downloader,
        IUnpacker unpacker,
        IInstallVersionEvents? events = null,
        IProgress<double>? progress = null,
        CancellationToken ct = default)
    {
        var os = GameExecutable.ToGameOs(input.Platform);

        if (input.InstalledVersions.Contains(input.Version.Version))
            return InstallVersionResult.Failure(InstallVersionFailure.VersionAlreadyInstalled);
        if (input.FoldersInUse.Contains(input.TargetFolder))
            return InstallVersionResult.Failure(InstallVersionFailure.FolderInUse);

        var download = DownloadFor(input.Version, os);
        if (download is null)
            return InstallVersionResult.Failure(InstallVersionFailure.NoDownloadForOs);

        events?.OnRegistered();

        var downloaded = await downloader.DownloadAsync(download.Url, input.TargetFolder, download.FileName, progress, ct);
        if (!downloaded.Ok || string.IsNullOrEmpty(downloaded.FilePath))
        {
            events?.OnDiscarded(InstallVersionFailure.DownloadFailed);
            return InstallVersionResult.Failure(InstallVersionFailure.DownloadFailed);
        }

        UnpackResult unpack;
        if (os == GameOs.Win32)
            unpack = await unpacker.RunInstallerAsync(downloaded.FilePath, input.TargetFolder, ct);
        else
            unpack = await unpacker.ExtractArchiveAsync(downloaded.FilePath, input.TargetFolder, progress, ct);

        if (!unpack.Ok)
        {
            events?.OnDiscarded(InstallVersionFailure.UnpackFailed);
            return InstallVersionResult.Failure(InstallVersionFailure.UnpackFailed);
        }

        if (!GameLanded(input.TargetFolder, os))
        {
            events?.OnDiscarded(InstallVersionFailure.GameExecutableMissing);
            return InstallVersionResult.Failure(InstallVersionFailure.GameExecutableMissing);
        }

        events?.OnInstalled();
        return InstallVersionResult.Success(input.TargetFolder);
    }

    private static GameVersionDownload? DownloadFor(DownloadableGameVersion version, GameOs os)
    {
        var download = os switch
        {
            GameOs.Win32 => version.Downloads.Win32,
            GameOs.Darwin => version.Downloads.Darwin,
            _ => version.Downloads.Linux
        };
        return !string.IsNullOrEmpty(download.Url) && !string.IsNullOrEmpty(download.FileName)
            ? download
            : null;
    }

    private static bool GameLanded(string folder, GameOs os)
    {
        var candidates = GameExecutable.ExpectedGameExecutables(os);
        if (candidates.Count == 0) return true;
        return candidates.Any(c => File.Exists(System.IO.Path.Combine(folder, c)));
    }
}
