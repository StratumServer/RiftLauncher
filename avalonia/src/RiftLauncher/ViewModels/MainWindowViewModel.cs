using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Microsoft.Extensions.DependencyInjection;
using RiftLauncher.Core.Services;

namespace RiftLauncher.ViewModels;

public partial class NavItemViewModel : ObservableObject
{
    private readonly Action<NavItemViewModel> _select;

    public NavItemViewModel(string iconData, string title, string? description, Action<NavItemViewModel> select)
    {
        IconData = iconData;
        Title = title;
        Description = description;
        _select = select;
    }

    public string Title { get; }
    public string? Description { get; }
    public string IconData { get; }
    public bool HasDescription => !string.IsNullOrEmpty(Description);

    [ObservableProperty]
    private bool _isActive;

    [RelayCommand]
    private void Select() => _select(this);
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
            if (value >= 0 && value < NavItems.Count && SetProperty(ref _selectedNavIndex, value))
                OnNavItemSelected(NavItems[value]);
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
    public NotificationsViewModel Notifications { get; }

    public ObservableCollection<NavItemViewModel> NavItems { get; }

    public MainWindowViewModel(
        IServiceProvider services,
        TasksViewModel tasksViewModel,
        SessionViewModel sessionViewModel,
        NotificationsViewModel notificationsViewModel,
        IConfigService configService,
        IAccountService accountService)
    {
        _services = services;
        _configService = configService;
        _accountService = accountService;
        Tasks = tasksViewModel;
        Session = sessionViewModel;
        Notifications = notificationsViewModel;

        NavItems = new ObservableCollection<NavItemViewModel>
        {
            new("M10,20V14H14V20H19V12H22L12,3L2,12H5V20H10Z", "Home", "Main page", OnNavItemSelected),
            new("M10,4H4C2.89,4 2,4.89 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V8C22,6.89 21.1,6 20,6H12L10,4Z", "Installations", "Manage game installations", OnNavItemSelected),
            new("M2.6,10.59L8.38,4.8L10.07,6.5C9.83,7.35 10.22,8.28 11,8.73V14.27C10.4,14.61 10,15.26 10,16A2,2 0 0,0 12,18A2,2 0 0,0 14,16C14,15.26 13.6,14.61 13,14.27V9.41L15.07,11.5C15,11.65 15,11.82 15,12A2,2 0 0,0 17,14A2,2 0 0,0 19,12A2,2 0 0,0 17,10C16.82,10 16.65,10 16.5,10.07L13.93,7.5C14.19,6.57 13.71,5.55 12.78,5.16C12.35,4.97 11.89,4.94 11.47,5.06L9.8,3.38L10.59,2.6C11.37,1.81 12.63,1.81 13.41,2.6L21.4,10.59C22.19,11.37 22.19,12.63 21.4,13.41L13.41,21.4C12.63,22.19 11.37,22.19 10.59,21.4L2.6,13.41C1.81,12.63 1.81,11.37 2.6,10.59Z", "VS Versions", "Manage game versions", OnNavItemSelected),
            new("M22.7,19L13.6,9.9C14.5,7.6 14,4.9 12.1,3C10.1,1 7.1,0.6 4.7,1.7L8.5,5.5L5.5,8.5L1.7,4.7C0.6,7.1 1.1,10.1 3.1,12.1C5,14 7.7,14.5 9.9,13.6L19,22.7C19.4,23.1 20,23.1 20.4,22.7L22.6,20.5C23.1,20.1 23.1,19.4 22.7,19Z", "Mods", "Browse and manage mods", OnNavItemSelected),
            new("M12,15.5A3.5,3.5 0 0,1 8.5,12A3.5,3.5 0 0,1 12,8.5A3.5,3.5 0 0,1 15.5,12A3.5,3.5 0 0,1 12,15.5M19.43,12.97C19.47,12.65 19.5,12.33 19.5,12C19.5,11.67 19.47,11.34 19.43,11L21.54,9.37C21.73,9.22 21.78,8.95 21.66,8.73L19.66,5.27C19.54,5.05 19.27,4.96 19.05,5.05L16.56,6.05C16.04,5.66 15.5,5.32 14.87,5.07L14.5,2.42C14.46,2.18 14.25,2 14,2H10C9.75,2 9.54,2.18 9.5,2.42L9.13,5.07C8.5,5.32 7.96,5.66 7.44,6.05L4.95,5.05C4.73,4.96 4.46,5.05 4.34,5.27L2.34,8.73C2.21,8.95 2.27,9.22 2.46,9.37L4.57,11C4.53,11.34 4.5,11.67 4.5,12C4.5,12.33 4.53,12.65 4.57,12.97L2.46,14.63C2.27,14.78 2.21,15.05 2.34,15.27L4.34,18.73C4.46,18.95 4.73,19.04 4.95,18.95L7.44,17.94C7.96,18.34 8.5,18.68 9.13,18.93L9.5,21.58C9.54,21.82 9.75,22 10,22H14C14.25,22 14.46,21.82 14.5,21.58L14.87,18.93C15.5,18.67 16.04,18.34 16.56,17.94L19.05,18.95C19.27,19.04 19.54,18.95 19.66,18.73L21.66,15.27C21.78,15.05 21.73,14.78 21.54,14.63L19.43,12.97Z", "Config", "Launcher settings", OnNavItemSelected),
            new("M11,9H13V7H11M12,20C7.59,20 4,16.41 4,12C4,7.59 7.59,4 12,4C16.41,4 20,7.59 20,12C20,16.41 16.41,20 12,20M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M11,17H13V11H11V17Z", "Info & Help", "About and support", OnNavItemSelected),
        };

        // Select Home by default
        OnNavItemSelected(NavItems[0]);
        _ = LoadInstallationStateAsync();
    }

    [RelayCommand]
    private void Navigate(object? parameter)
    {
        if (parameter is NavItemViewModel navItem)
            OnNavItemSelected(navItem);
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
        // Navigate to mods
        OnNavItemSelected(NavItems[3]);
    }

    [RelayCommand]
    private void QuickEdit()
    {
        // TODO: Navigate to edit current installation
    }

    [RelayCommand]
    private void QuickAdd()
    {
        OnNavItemSelected(NavItems[1]);
        // TODO: Navigate directly to add installation sub-page
    }

    public void NavigateToSubPage(ViewModelBase viewModel)
    {
        CurrentPage = viewModel;
    }

    private void OnNavItemSelected(NavItemViewModel selected)
    {
        foreach (var item in NavItems)
            item.IsActive = item == selected;

        var index = NavItems.IndexOf(selected);
        _selectedNavIndex = index;
        OnPropertyChanged(nameof(SelectedNavIndex));

        Console.WriteLine($"[NAV] OnNavItemSelected index={index} title={selected.Title}");

        CurrentPage = index switch
        {
            0 => _services.GetRequiredService<Pages.HomeViewModel>(),
            1 => CreateInstallationsListVm(),
            2 => CreateVersionsListVm(),
            3 => _services.GetRequiredService<Pages.ModsListViewModel>(),
            4 => _services.GetRequiredService<Pages.ConfigViewModel>(),
            5 => _services.GetRequiredService<Pages.InfoHelpViewModel>(),
            _ => CurrentPage
        };
        Console.WriteLine($"[NAV] CurrentPage = {CurrentPage?.GetType().Name ?? "null"}");
    }

    private Pages.InstallationsListViewModel CreateInstallationsListVm()
    {
        var vm = _services.GetRequiredService<Pages.InstallationsListViewModel>();
        // TODO: wire sub-navigation (add/edit/backups/mods)
        return vm;
    }

    private Pages.VersionsListViewModel CreateVersionsListVm()
    {
        var vm = _services.GetRequiredService<Pages.VersionsListViewModel>();
        vm.NavigateToAdd = () =>
        {
            var addVm = new Pages.VersionAddViewModel(
                _services.GetRequiredService<IConfigService>(),
                _services.GetRequiredService<IVersionCatalogService>(),
                _services.GetRequiredService<ITaskManagerService>(),
                _services.GetRequiredService<IDownloadService>(),
                _services.GetRequiredService<IArchiveService>(),
                null,
                () => OnNavItemSelected(NavItems[2]));
            NavigateToSubPage(addVm);
        };
        vm.NavigateToLookup = () =>
        {
            var lookupVm = new Pages.VersionLookupViewModel(
                _services.GetRequiredService<IConfigService>(),
                () => OnNavItemSelected(NavItems[2]));
            NavigateToSubPage(lookupVm);
        };
        return vm;
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
