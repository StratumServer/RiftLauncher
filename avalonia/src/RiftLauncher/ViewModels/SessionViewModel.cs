using CommunityToolkit.Mvvm.ComponentModel;
using RiftLauncher.Core.Services;

namespace RiftLauncher.ViewModels;

public partial class SessionViewModel : ViewModelBase
{
    private readonly IAccountService _accountService;

    [ObservableProperty]
    private string _playerName = "";

    [ObservableProperty]
    private bool _isLoggedIn;

    public LoginViewModel Login { get; }

    public SessionViewModel(IAccountService accountService, LoginViewModel loginViewModel)
    {
        _accountService = accountService;
        Login = loginViewModel;

        UpdateState();
        _accountService.SessionChanged += UpdateState;
    }

    public SessionViewModel() : this(null!, null!)
    {
    }

    private void UpdateState()
    {
        if (_accountService is null) return;
        IsLoggedIn = _accountService.IsLoggedIn;
        PlayerName = _accountService.CurrentSession?.PlayerName ?? "";
    }
}
