using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RiftLauncher.Core.Domain.Config;
using RiftLauncher.Core.Domain.Versions;
using RiftLauncher.Core.Services;

namespace RiftLauncher.ViewModels.Pages;

public partial class VersionLookupViewModel : ViewModelBase
{
    private readonly IConfigService _configService;
    private readonly Action _goBack;

    [ObservableProperty]
    private string _folder = "";

    [ObservableProperty]
    private string _versionFound = "";

    [ObservableProperty]
    private bool _canAdd;

    public VersionLookupViewModel(IConfigService configService, Action goBack)
    {
        _configService = configService;
        _goBack = goBack;
    }

    public VersionLookupViewModel() : this(null!, () => { })
    {
    }

    [RelayCommand]
    private async Task DetectFolderAsync(Func<Task<string?>>? folderPicker = null)
    {
        string? selected = null;
        if (folderPicker != null)
            selected = await folderPicker();

        if (string.IsNullOrEmpty(selected)) return;
        Folder = selected;

        var platform = GetCurrentPlatform();
        var files = Directory.Exists(Folder)
            ? Directory.GetFiles(Folder).Select(Path.GetFileName).Where(f => f != null).Cast<string>().ToList()
            : [];

        var input = new DetectVersionInput(platform, Folder, files);
        var result = await VersionDetector.DetectAsync(input);

        if (result.Ok && !string.IsNullOrEmpty(result.Version))
        {
            VersionFound = result.Version;
            var config = await _configService.GetConfigAsync();
            CanAdd = !config.GameVersions.Any(v => v.Version == result.Version);
        }
        else
        {
            VersionFound = "Not detected";
            CanAdd = false;
        }
    }

    [RelayCommand]
    private async Task AddVersionAsync()
    {
        if (!CanAdd || string.IsNullOrEmpty(VersionFound) || string.IsNullOrEmpty(Folder)) return;

        var config = await _configService.GetConfigAsync();
        config.GameVersions.Add(new GameVersion
        {
            Version = VersionFound,
            Path = Folder
        });
        await _configService.SaveConfigAsync(config);
        _goBack();
    }

    [RelayCommand]
    private void GoBack() => _goBack();

    private static string GetCurrentPlatform()
    {
        if (OperatingSystem.IsWindows()) return "win32";
        if (OperatingSystem.IsMacOS()) return "darwin";
        return "linux";
    }
}
