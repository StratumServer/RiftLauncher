using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RiftLauncher.Core.Domain.Config;
using RiftLauncher.Core.Services;
using Microsoft.Extensions.Logging;

namespace RiftLauncher.ViewModels.Pages;

public partial class ModsListViewModel : ViewModelBase
{
    private readonly IModDbService _modDbService;
    private readonly IConfigService _configService;
    private readonly ITaskManagerService _taskManager;
    private readonly IDownloadService _downloadService;
    private readonly ILogger<ModsListViewModel>? _logger;

    [ObservableProperty]
    private List<ModListEntry> _mods = [];

    [ObservableProperty]
    private List<ModListEntry> _filteredMods = [];

    [ObservableProperty]
    private ModListEntry? _selectedMod;

    [ObservableProperty]
    private bool _isSearching = true;

    [ObservableProperty]
    private bool _showInstallDialog;

    [ObservableProperty]
    private string _textFilter = "";

    [ObservableProperty]
    private string _sideFilter = "any";

    [ObservableProperty]
    private string _orderBy = "follows";

    [ObservableProperty]
    private string _orderDirection = "desc";

    [ObservableProperty]
    private bool _onlyFavorites;

    [ObservableProperty]
    private int _visibleCount = 45;

    private List<int> _favModIds = [];
    private List<string> _installedModIds = [];
    private string _installationPath = "";

    public ModsListViewModel(
        IModDbService modDbService,
        IConfigService configService,
        ITaskManagerService taskManager,
        IDownloadService downloadService,
        ILogger<ModsListViewModel>? logger)
    {
        _modDbService = modDbService;
        _configService = configService;
        _taskManager = taskManager;
        _downloadService = downloadService;
        _logger = logger;

        _ = InitializeAsync();
    }

    public ModsListViewModel() : this(null!, null!, null!, null!, null)
    {
    }

    private async Task InitializeAsync()
    {
        if (_configService is null) return;
        var config = await _configService.GetConfigAsync();
        _favModIds = config.FavMods?.ToList() ?? [];

        var lastInstallation = config.Installations
            .FirstOrDefault(i => i.Id == config.LastUsedInstallation);
        if (lastInstallation != null)
            _installationPath = lastInstallation.Path;

        await SearchModsAsync();
    }

    partial void OnTextFilterChanged(string value) => _ = SearchModsDebounceAsync();
    partial void OnSideFilterChanged(string value) => _ = SearchModsAsync();
    partial void OnOrderByChanged(string value) => _ = SearchModsAsync();
    partial void OnOrderDirectionChanged(string value) => _ = SearchModsAsync();
    partial void OnOnlyFavoritesChanged(bool value) => ApplyLocalFilters();

    private System.Timers.Timer? _debounceTimer;

    private Task SearchModsDebounceAsync()
    {
        _debounceTimer?.Stop();
        _debounceTimer?.Dispose();
        _debounceTimer = new System.Timers.Timer(400);
        _debounceTimer.AutoReset = false;
        _debounceTimer.Elapsed += (_, _) => _ = SearchModsAsync();
        _debounceTimer.Start();
        return Task.CompletedTask;
    }

    [RelayCommand]
    private async Task SearchModsAsync()
    {
        if (_modDbService is null) return;

        IsSearching = true;
        var query = new ModQueryParams(
            TextFilter: TextFilter,
            Side: SideFilter,
            OrderBy: OrderBy,
            OrderDirection: OrderDirection);

        var results = await _modDbService.QueryModsAsync(query);
        Mods = results.ToList();
        ApplyLocalFilters();
        IsSearching = false;
    }

    private void ApplyLocalFilters()
    {
        var filtered = Mods.AsEnumerable();

        if (OnlyFavorites)
            filtered = filtered.Where(m => _favModIds.Contains(int.TryParse(m.AssetId, out var id) ? id : -1));

        FilteredMods = filtered.ToList();
        VisibleCount = 45;
    }

    [RelayCommand]
    private void LoadMore()
    {
        VisibleCount += 15;
    }

    [RelayCommand]
    private void SelectMod(ModListEntry mod)
    {
        SelectedMod = mod;
        ShowInstallDialog = true;
    }

    [RelayCommand]
    private void CloseInstallDialog()
    {
        ShowInstallDialog = false;
        SelectedMod = null;
    }

    [RelayCommand]
    private async Task InstallModAsync()
    {
        if (SelectedMod is null || string.IsNullOrEmpty(_installationPath)) return;

        var detail = await _modDbService.GetModDetailsAsync(SelectedMod.AssetId);
        if (detail is null || detail.Releases.Count == 0) return;

        var release = detail.Releases[0];
        var modsFolderPath = Path.Combine(_installationPath, "Mods");

        var task = _taskManager.StartTask(
            $"Install {SelectedMod.Name}",
            $"Downloading mod {SelectedMod.Name} v{release.ModVersion}",
            TaskItemType.Download);

        try
        {
            var downloadUrl = $"https://mods.vintagestory.at/download?fileid={release.MainFile}";
            var progress = new Progress<double>(p => _taskManager.UpdateProgress(task.Id, p));
            await _modDbService.DownloadModAsync(downloadUrl, modsFolderPath, progress, task.Cancellation.Token);
            _taskManager.CompleteTask(task.Id);
        }
        catch (OperationCanceledException)
        {
            _taskManager.FailTask(task.Id, "Cancelled");
        }
        catch (Exception ex)
        {
            _logger?.LogError(ex, "Failed to install mod {ModName}", SelectedMod.Name);
            _taskManager.FailTask(task.Id, ex.Message);
        }

        ShowInstallDialog = false;
        SelectedMod = null;
    }

    [RelayCommand]
    private async Task ToggleFavoriteAsync(ModListEntry mod)
    {
        var assetId = int.TryParse(mod.AssetId, out var id) ? id : -1;
        if (_favModIds.Contains(assetId))
            _favModIds.Remove(assetId);
        else
            _favModIds.Add(assetId);

        var config = await _configService.GetConfigAsync();
        config.FavMods = _favModIds;
        await _configService.SaveConfigAsync(config);

        if (OnlyFavorites)
            ApplyLocalFilters();
    }

    [RelayCommand]
    private void OpenModOnBrowser(ModListEntry mod)
    {
        var url = $"https://mods.vintagestory.at/show/mod/{mod.AssetId}";
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = url,
                UseShellExecute = true
            });
        }
        catch { }
    }

    [RelayCommand]
    private void ClearFilters()
    {
        TextFilter = "";
        SideFilter = "any";
        OnlyFavorites = false;
        OrderBy = "follows";
        OrderDirection = "desc";
    }

    public bool IsFavorite(ModListEntry mod) => _favModIds.Contains(int.TryParse(mod.AssetId, out var id) ? id : -1);
    public bool IsInstalled(ModListEntry mod) => _installedModIds.Contains(mod.ModId);
}
