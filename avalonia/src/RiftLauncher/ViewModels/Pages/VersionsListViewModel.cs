using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RiftLauncher.Core.Domain.Config;
using RiftLauncher.Core.Domain.Versions;
using RiftLauncher.Core.Services;

namespace RiftLauncher.ViewModels.Pages;

public partial class VersionsListViewModel : ViewModelBase
{
    private readonly IConfigService _configService;
    private readonly ITaskManagerService _taskManager;

    [ObservableProperty]
    private List<GameVersionDisplay> _versions = [];

    [ObservableProperty]
    private GameVersionDisplay? _versionToDelete;

    [ObservableProperty]
    private bool _showDeleteDialog;

    [ObservableProperty]
    private bool _showInUseWarning;

    [ObservableProperty]
    private string _inUseInstallations = "";

    public Action? NavigateToAdd { get; set; }
    public Action? NavigateToLookup { get; set; }

    [RelayCommand]
    private void NavigateToAddPage() => NavigateToAdd?.Invoke();

    [RelayCommand]
    private void NavigateToLookupPage() => NavigateToLookup?.Invoke();

    public VersionsListViewModel(IConfigService configService, ITaskManagerService taskManager)
    {
        _configService = configService;
        _taskManager = taskManager;
        _ = LoadVersionsAsync();
    }

    public VersionsListViewModel() : this(null!, null!)
    {
    }

    private async Task LoadVersionsAsync()
    {
        if (_configService is null) return;
        var config = await _configService.GetConfigAsync();
        Versions = config.GameVersions
            .OrderByDescending(v => v.Version, StringComparer.OrdinalIgnoreCase)
            .Select(v => new GameVersionDisplay(v.Version, v.Path))
            .ToList();
    }

    [RelayCommand]
    private async Task RequestDeleteAsync(GameVersionDisplay version)
    {
        VersionToDelete = version;

        var config = await _configService.GetConfigAsync();
        var usedBy = config.Installations
            .Where(i => i.Version == version.Version)
            .Select(i => i.Name)
            .ToList();

        if (usedBy.Count > 0)
        {
            InUseInstallations = string.Join(", ", usedBy);
            ShowInUseWarning = true;
        }
        else
        {
            ShowDeleteDialog = true;
        }
    }

    [RelayCommand]
    private async Task ConfirmDeleteAsync()
    {
        var wasInUseWarning = ShowInUseWarning;
        ShowDeleteDialog = false;
        ShowInUseWarning = false;

        if (VersionToDelete is null) return;

        var target = VersionToDelete;
        VersionToDelete = null;

        var config = await _configService.GetConfigAsync();
        var gv = config.GameVersions.FirstOrDefault(v => v.Version == target.Version);
        if (gv is null) return;

        var usedBy = config.Installations
            .Where(i => i.Version == target.Version)
            .Select(i => i.Name)
            .ToList();

        var snapshot = new GameVersionSnapshot(gv.Version, gv.Path, IsPlaying: false, IsDeleting: false);
        var input = new UninstallVersionInput(snapshot, usedBy, ConfirmedInUse: wasInUseWarning);
        var result = await VersionUninstaller.UninstallAsync(input);

        if (result.Ok)
        {
            config.GameVersions.RemoveAll(v => v.Version == target.Version);
            await _configService.SaveConfigAsync(config);
            await LoadVersionsAsync();
        }
    }

    [RelayCommand]
    private void CancelDelete()
    {
        ShowDeleteDialog = false;
        ShowInUseWarning = false;
        VersionToDelete = null;
    }

    [RelayCommand]
    private void OpenFolder(GameVersionDisplay version)
    {
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = version.Path,
                UseShellExecute = true
            });
        }
        catch
        {
            // Folder may not exist
        }
    }
}

public sealed record GameVersionDisplay(string Version, string Path);
