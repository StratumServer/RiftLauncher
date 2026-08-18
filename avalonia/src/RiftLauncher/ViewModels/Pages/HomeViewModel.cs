using System.Diagnostics;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RiftLauncher.Core.Services;

namespace RiftLauncher.ViewModels.Pages;

public partial class HomeViewModel : ViewModelBase
{
    private const string VideoId = "mgvzBB_--xM";

    [ObservableProperty]
    private string _welcomeMessage = "Welcome to Rift Launcher";

    [ObservableProperty]
    private int _installationsCount;

    [ObservableProperty]
    private int _versionsCount;

    [ObservableProperty]
    private string _lastUsedInstallation = "";

    private readonly IConfigService? _configService;

    public HomeViewModel(IConfigService configService)
    {
        _configService = configService;
        _ = LoadStatsAsync();
    }

    public HomeViewModel()
    {
    }

    [RelayCommand]
    private void OpenTrailer()
    {
        Process.Start(new ProcessStartInfo
        {
            FileName = $"https://www.youtube.com/watch?v={VideoId}",
            UseShellExecute = true
        });
    }

    private async Task LoadStatsAsync()
    {
        if (_configService is null) return;
        var config = await _configService.GetConfigAsync();
        InstallationsCount = config.Installations.Count;
        VersionsCount = config.GameVersions.Count;

        var last = config.Installations.FirstOrDefault(i => i.Id == config.LastUsedInstallation);
        LastUsedInstallation = last?.Name ?? "";
    }
}
