using System.Collections.ObjectModel;
using Avalonia.Media;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Microsoft.Extensions.DependencyInjection;
using RiftLauncher.Core.Services;

namespace RiftLauncher.ViewModels;

public partial class NavItemViewModel : ObservableObject
{
    public int Index { get; init; }
    public string Title { get; init; } = "";
    public string? Description { get; init; }
    public string IconData { get; init; } = "";
    public bool HasDescription => !string.IsNullOrEmpty(Description);

    [ObservableProperty]
    private bool _isActive;

    public IBrush? ActiveBrush => IsActive
        ? new SolidColorBrush(Color.Parse("#7e501e"))
        : Brushes.Transparent;

    partial void OnIsActiveChanged(bool value)
    {
        OnPropertyChanged(nameof(ActiveBrush));
    }
}

public partial class MainWindowViewModel : ViewModelBase
{
    private readonly IServiceProvider _services;
    private readonly IConfigService _configService;
    private readonly IAccountService _accountService;

    [ObservableProperty]
    private ViewModelBase? _currentPage;

    private int _selectedNavIndex;
    public int SelectedNavIndex
    {
        get => _selectedNavIndex;
        set
        {
            if (SetProperty(ref _selectedNavIndex, value))
                NavigateToIndex(value);
        }
    }

    [ObservableProperty]
    private string _windowTitle = "Rift Launcher";

    [ObservableProperty]
    private string _currentInstallationName = "No installation selected";

    [ObservableProperty]
    private string _currentInstallationDesc = "Select an installation";

    [ObservableProperty]
    private string _sessionDisplayName = "Log In";

    [ObservableProperty]
    private bool _isLoggedIn;

    [ObservableProperty]
    private bool _hasInstallationSelected;

    [ObservableProperty]
    private bool _isPlaying;

    public TasksViewModel Tasks { get; }
    public SessionViewModel Session { get; }

    public ObservableCollection<NavItemViewModel> NavItems { get; } = new()
    {
        new() { Index = 0, Title = "Home", Description = "Overview", IconData = "M10,20V14H14V20H19V12H22L12,3L2,12H5V20H10Z" },
        new() { Index = 1, Title = "Installations", Description = "Manage game instances", IconData = "M4,6H20V16H4M4,4A2,2 0 0,0 2,6V16A2,2 0 0,0 4,18H8L10,20H14L16,18H20A2,2 0 0,0 22,16V6A2,2 0 0,0 20,4H4Z" },
        new() { Index = 2, Title = "VS Versions", Description = "Download & manage", IconData = "M12,3L2,12H5V20H19V12H22L12,3M12,8.75A2.25,2.25 0 0,1 14.25,11A2.25,2.25 0 0,1 12,13.25A2.25,2.25 0 0,1 9.75,11A2.25,2.25 0 0,1 12,8.75Z" },
        new() { Index = 3, Title = "Mods", Description = "Browse & install", IconData = "M12,2L2,7L12,12L22,7L12,2M2,17L12,22L22,17L12,12L2,17Z" },
        new() { Index = 4, Title = "Config", Description = "Settings", IconData = "M12,15.5A3.5,3.5 0 0,1 8.5,12A3.5,3.5 0 0,1 12,8.5A3.5,3.5 0 0,1 15.5,12A3.5,3.5 0 0,1 12,15.5M19.43,12.97C19.47,12.65 19.5,12.33 19.5,12C19.5,11.67 19.47,11.34 19.43,11L21.54,9.37C21.73,9.22 21.78,8.95 21.66,8.73L19.66,5.27C19.54,5.05 19.27,4.96 19.05,5.05L16.56,6.05C16.04,5.66 15.5,5.32 14.87,5.07L14.5,2.42C14.46,2.18 14.25,2 14,2H10C9.75,2 9.54,2.18 9.5,2.42L9.13,5.07C8.5,5.32 7.96,5.66 7.44,6.05L4.95,5.05C4.73,4.96 4.46,5.05 4.34,5.27L2.34,8.73C2.21,8.95 2.27,9.22 2.46,9.37L4.57,11C4.53,11.34 4.5,11.67 4.5,12C4.5,12.33 4.53,12.65 4.57,12.97L2.46,14.63C2.27,14.78 2.21,15.05 2.34,15.27L4.34,18.73C4.46,18.95 4.73,19.04 4.95,18.95L7.44,17.94C7.96,18.34 8.5,18.68 9.13,18.93L9.5,21.58C9.54,21.82 9.75,22 10,22H14C14.25,22 14.46,21.82 14.5,21.58L14.87,18.93C15.5,18.67 16.04,18.34 16.56,17.94L19.05,18.95C19.27,19.04 19.54,18.95 19.66,18.73L21.66,15.27C21.78,15.05 21.73,14.78 21.54,14.63L19.43,12.97Z" },
        new() { Index = 5, Title = "Info & Help", IconData = "M11,9H13V7H11M12,20C7.59,20 4,16.41 4,12C4,7.59 7.59,4 12,4C16.41,4 20,7.59 20,12C20,16.41 16.41,20 12,20M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M11,17H13V11H11V17Z" },
    };

    public MainWindowViewModel(
        IServiceProvider services,
        TasksViewModel tasksViewModel,
        SessionViewModel sessionViewModel,
        IConfigService configService,
        IAccountService accountService)
    {
        _services = services;
        _configService = configService;
        _accountService = accountService;
        Tasks = tasksViewModel;
        Session = sessionViewModel;
        NavigateToIndex(0);
        _ = LoadInstallationStateAsync();
    }

    [RelayCommand]
    private void Navigate(object? parameter)
    {
        if (parameter is int index)
            NavigateToIndex(index);
    }

    [RelayCommand]
    private async Task PlayAsync()
    {
        // TODO: Full play logic (validate installation, run game, track time)
        await Task.CompletedTask;
    }

    [RelayCommand]
    private void QuickBackup()
    {
        // TODO: Make backup of current installation
    }

    [RelayCommand]
    private void QuickMods()
    {
        // TODO: Navigate to manage mods for current installation
    }

    [RelayCommand]
    private void QuickEdit()
    {
        // TODO: Navigate to edit current installation
    }

    [RelayCommand]
    private void QuickAdd()
    {
        NavigateToIndex(1);
        // TODO: Navigate directly to add installation sub-page
    }

    public void NavigateToSubPage(ViewModelBase viewModel)
    {
        CurrentPage = viewModel;
    }

    private void NavigateToIndex(int index)
    {
        foreach (var item in NavItems)
            item.IsActive = item.Index == index;

        CurrentPage = index switch
        {
            0 => _services.GetRequiredService<Pages.HomeViewModel>(),
            1 => _services.GetRequiredService<Pages.InstallationsListViewModel>(),
            2 => _services.GetRequiredService<Pages.VersionsListViewModel>(),
            3 => _services.GetRequiredService<Pages.ModsListViewModel>(),
            4 => _services.GetRequiredService<Pages.ConfigViewModel>(),
            5 => _services.GetRequiredService<Pages.InfoHelpViewModel>(),
            _ => CurrentPage
        };
    }

    private async Task LoadInstallationStateAsync()
    {
        try
        {
            var config = await _configService.GetConfigAsync();
            if (!string.IsNullOrEmpty(config.LastUsedInstallation))
            {
                var inst = config.Installations?.FirstOrDefault(i => i.Id == config.LastUsedInstallation);
                if (inst != null)
                {
                    CurrentInstallationName = inst.Name;
                    CurrentInstallationDesc = $"v{inst.Version} · {inst.ModsCount} mods";
                    HasInstallationSelected = true;
                }
            }
        }
        catch
        {
            // Config not loaded yet, use defaults
        }
    }
}
