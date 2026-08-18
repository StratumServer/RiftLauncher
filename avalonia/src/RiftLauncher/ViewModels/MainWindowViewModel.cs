using CommunityToolkit.Mvvm.ComponentModel;

namespace RiftLauncher.ViewModels;

public partial class MainWindowViewModel : ViewModelBase
{
    [ObservableProperty]
    private ViewModelBase? _currentPage;

    [ObservableProperty]
    private int _selectedNavIndex;

    [ObservableProperty]
    private string _windowTitle = "Rift Launcher";

    public MainWindowViewModel()
    {
        CurrentPage = new Pages.HomeViewModel();
    }

    partial void OnSelectedNavIndexChanged(int value)
    {
        CurrentPage = value switch
        {
            0 => new Pages.HomeViewModel(),
            1 => new Pages.InstallationsListViewModel(),
            2 => new Pages.VersionsListViewModel(),
            3 => new Pages.ModsListViewModel(),
            4 => new Pages.ConfigViewModel(),
            5 => new Pages.InfoHelpViewModel(),
            _ => CurrentPage
        };
    }
}
