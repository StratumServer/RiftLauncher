using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RiftLauncher.Core.Domain.Config;
using RiftLauncher.Core.Domain.Versions;
using RiftLauncher.Core.Services;
using Microsoft.Extensions.Logging;

namespace RiftLauncher.ViewModels.Pages;

public partial class VersionAddViewModel : ViewModelBase
{
    private readonly IConfigService _configService;
    private readonly IVersionCatalogService _catalogService;
    private readonly ITaskManagerService _taskManager;
    private readonly IDownloadService _downloadService;
    private readonly IArchiveService _archiveService;
    private readonly ILogger<VersionAddViewModel>? _logger;
    private readonly Action _goBack;

    [ObservableProperty]
    private List<VersionCatalogEntry> _allVersions = [];

    [ObservableProperty]
    private List<VersionCatalogEntry> _filteredVersions = [];

    [ObservableProperty]
    private VersionCatalogEntry? _selectedVersion;

    [ObservableProperty]
    private string _installFolder = "";

    [ObservableProperty]
    private bool _showStable = true;

    [ObservableProperty]
    private bool _showRc;

    [ObservableProperty]
    private bool _showPre;

    [ObservableProperty]
    private bool _isLoading = true;

    [ObservableProperty]
    private bool _hasFailed;

    private IReadOnlyList<string> _installedVersions = [];

    public VersionAddViewModel(
        IConfigService configService,
        IVersionCatalogService catalogService,
        ITaskManagerService taskManager,
        IDownloadService downloadService,
        IArchiveService archiveService,
        ILogger<VersionAddViewModel>? logger,
        Action goBack)
    {
        _configService = configService;
        _catalogService = catalogService;
        _taskManager = taskManager;
        _downloadService = downloadService;
        _archiveService = archiveService;
        _logger = logger;
        _goBack = goBack;

        _ = InitializeAsync();
    }

    public VersionAddViewModel() : this(null!, null!, null!, null!, null!, null, () => { })
    {
    }

    private async Task InitializeAsync()
    {
        if (_configService is null) return;
        var config = await _configService.GetConfigAsync();
        _installedVersions = config.GameVersions.Select(v => v.Version).ToList();
        await LoadCatalogAsync();
    }

    private async Task LoadCatalogAsync()
    {
        try
        {
            IsLoading = true;
            HasFailed = false;
            var entries = await _catalogService.FetchCatalogAsync();
            AllVersions = entries.ToList();
            ApplyFilters();
            IsLoading = false;
        }
        catch (Exception ex)
        {
            _logger?.LogError(ex, "Failed to load version catalog");
            IsLoading = false;
            HasFailed = true;
        }
    }

    partial void OnShowStableChanged(bool value) => ApplyFilters();
    partial void OnShowRcChanged(bool value) => ApplyFilters();
    partial void OnShowPreChanged(bool value) => ApplyFilters();

    private void ApplyFilters()
    {
        FilteredVersions = AllVersions
            .Where(v => v.Type switch
            {
                "stable" => ShowStable,
                "rc" => ShowRc,
                "pre" => ShowPre,
                _ => false
            })
            .ToList();

        if (SelectedVersion is null || !FilteredVersions.Contains(SelectedVersion))
        {
            SelectedVersion = FilteredVersions
                .FirstOrDefault(v => !_installedVersions.Contains(v.Version));
        }

        UpdateInstallFolder();
    }

    partial void OnSelectedVersionChanged(VersionCatalogEntry? value) => UpdateInstallFolder();

    private void UpdateInstallFolder()
    {
        if (SelectedVersion is null) return;
        var defaultBase = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "RiftLauncher", "versions");
        InstallFolder = Path.Combine(defaultBase, SelectedVersion.Version);
    }

    [RelayCommand]
    private async Task RetryAsync()
    {
        await LoadCatalogAsync();
    }

    [RelayCommand]
    private async Task InstallAsync()
    {
        if (SelectedVersion is null || string.IsNullOrWhiteSpace(InstallFolder)) return;

        var os = GetCurrentPlatform();
        var (url, fileName) = GetDownloadForPlatform(SelectedVersion, os);
        if (string.IsNullOrEmpty(url))
        {
            _logger?.LogWarning("No download available for {Version} on {Os}", SelectedVersion.Version, os);
            return;
        }

        var task = _taskManager.StartTask(
            $"Install {SelectedVersion.Version}",
            $"Downloading and installing VS {SelectedVersion.Version}",
            TaskItemType.Install);

        try
        {
            Directory.CreateDirectory(InstallFolder);

            var progress = new Progress<double>(p => _taskManager.UpdateProgress(task.Id, p * 0.7));
            var filePath = await _downloadService.DownloadAsync(url, InstallFolder, fileName, progress, task.Cancellation.Token);

            var extractProgress = new Progress<double>(p => _taskManager.UpdateProgress(task.Id, 70 + p * 0.3));
            await _archiveService.ExtractAsync(filePath, InstallFolder, extractProgress, task.Cancellation.Token);

            try { File.Delete(filePath); } catch { }

            var config = await _configService.GetConfigAsync();
            config.GameVersions.Add(new GameVersion
            {
                Version = SelectedVersion.Version,
                Path = InstallFolder
            });
            await _configService.SaveConfigAsync(config);

            _taskManager.CompleteTask(task.Id);
            _goBack();
        }
        catch (OperationCanceledException)
        {
            _taskManager.FailTask(task.Id, "Cancelled");
            TryCleanup(InstallFolder);
        }
        catch (Exception ex)
        {
            _logger?.LogError(ex, "Failed to install version {Version}", SelectedVersion.Version);
            _taskManager.FailTask(task.Id, ex.Message);
            TryCleanup(InstallFolder);
        }
    }

    [RelayCommand]
    private void GoBack() => _goBack();

    public bool IsInstalled(VersionCatalogEntry entry) => _installedVersions.Contains(entry.Version);

    private static string GetCurrentPlatform()
    {
        if (OperatingSystem.IsWindows()) return "win32";
        if (OperatingSystem.IsMacOS()) return "darwin";
        return "linux";
    }

    private static (string Url, string FileName) GetDownloadForPlatform(VersionCatalogEntry entry, string platform)
    {
        return platform switch
        {
            "win32" => (entry.WindowsUrl, entry.WindowsFileName),
            "darwin" => (entry.MacUrl, entry.MacFileName),
            _ => (entry.LinuxUrl, entry.LinuxFileName)
        };
    }

    private static void TryCleanup(string folder)
    {
        try
        {
            if (Directory.Exists(folder))
                Directory.Delete(folder, true);
        }
        catch { }
    }
}
