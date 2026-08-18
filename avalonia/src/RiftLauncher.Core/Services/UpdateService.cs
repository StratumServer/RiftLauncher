using Microsoft.Extensions.Logging;

namespace RiftLauncher.Core.Services;

public interface IUpdateService
{
    Task<UpdateCheckResult> CheckForUpdatesAsync(CancellationToken ct = default);
    Task ApplyUpdateAsync(IProgress<double>? progress = null, CancellationToken ct = default);
    bool UpdateAvailable { get; }
    string? LatestVersion { get; }
    event Action? UpdateStatusChanged;
}

public sealed record UpdateCheckResult(bool Available, string? Version = null, string? Error = null);

public sealed class UpdateService : IUpdateService
{
    private readonly ILogger<UpdateService> _logger;

    public bool UpdateAvailable { get; private set; }
    public string? LatestVersion { get; private set; }

#pragma warning disable CS0067 // Event unused until Velopack is wired
    public event Action? UpdateStatusChanged;
#pragma warning restore CS0067

    public UpdateService(ILogger<UpdateService> logger)
    {
        _logger = logger;
    }

    public async Task<UpdateCheckResult> CheckForUpdatesAsync(CancellationToken ct = default)
    {
        try
        {
            // Velopack integration point:
            // var mgr = new UpdateManager("https://github.com/StratumServer/RiftLauncher");
            // var updateInfo = await mgr.CheckForUpdatesAsync();
            // if (updateInfo != null)
            // {
            //     UpdateAvailable = true;
            //     LatestVersion = updateInfo.TargetFullRelease.Version.ToString();
            //     UpdateStatusChanged?.Invoke();
            //     return new UpdateCheckResult(true, LatestVersion);
            // }

            // Stub until Velopack is fully wired (requires packaged app):
            await Task.Delay(100, ct);
            _logger.LogInformation("Update check: no Velopack context (running in dev mode)");
            return new UpdateCheckResult(false);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Update check failed");
            return new UpdateCheckResult(false, Error: ex.Message);
        }
    }

    public async Task ApplyUpdateAsync(IProgress<double>? progress = null, CancellationToken ct = default)
    {
        if (!UpdateAvailable)
            return;

        try
        {
            // Velopack integration point:
            // var mgr = new UpdateManager("https://github.com/StratumServer/RiftLauncher");
            // var updateInfo = await mgr.CheckForUpdatesAsync();
            // await mgr.DownloadUpdatesAsync(updateInfo, p => progress?.Report(p));
            // mgr.ApplyUpdatesAndRestart(updateInfo);

            await Task.Delay(100, ct);
            _logger.LogInformation("Apply update: stub (Velopack not packaged)");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to apply update");
            throw;
        }
    }
}
