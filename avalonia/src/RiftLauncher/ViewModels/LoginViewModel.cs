using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RiftLauncher.Core.Domain.Account;
using RiftLauncher.Core.Services;

namespace RiftLauncher.ViewModels;

public partial class LoginViewModel : ViewModelBase
{
    private readonly IAccountService _accountService;

    [ObservableProperty]
    private string _email = "";

    [ObservableProperty]
    private string _password = "";

    [ObservableProperty]
    private string _totpCode = "";

    [ObservableProperty]
    private bool _needsTwoFactor;

    [ObservableProperty]
    private bool _isLoggingIn;

    [ObservableProperty]
    private string _errorMessage = "";

    [ObservableProperty]
    private bool _showDialog;

    private string? _preLoginToken;

    public LoginViewModel(IAccountService accountService)
    {
        _accountService = accountService;
    }

    public LoginViewModel() : this(null!)
    {
    }

    [RelayCommand]
    private void OpenDialog()
    {
        ShowDialog = true;
        ErrorMessage = "";
        NeedsTwoFactor = false;
        Email = "";
        Password = "";
        TotpCode = "";
    }

    [RelayCommand]
    private void CloseDialog()
    {
        ShowDialog = false;
        ErrorMessage = "";
    }

    [RelayCommand]
    private async Task LoginAsync()
    {
        if (string.IsNullOrWhiteSpace(Email) || string.IsNullOrWhiteSpace(Password))
        {
            ErrorMessage = "Email and password are required";
            return;
        }

        IsLoggingIn = true;
        ErrorMessage = "";

        try
        {
            LoginResult result;
            if (NeedsTwoFactor && !string.IsNullOrWhiteSpace(TotpCode))
            {
                result = await _accountService.LoginWithTwoFactorAsync(
                    Email, Password, TotpCode, _preLoginToken);
            }
            else
            {
                result = await _accountService.LoginAsync(Email, Password);
            }

            switch (result.Status)
            {
                case LoginStatus.Success:
                    ShowDialog = false;
                    break;
                case LoginStatus.NeedsTwoFactor:
                    NeedsTwoFactor = true;
                    _preLoginToken = result.PreLoginToken;
                    ErrorMessage = "";
                    break;
                case LoginStatus.BadCredentials:
                    ErrorMessage = "Invalid email or password";
                    break;
                case LoginStatus.TwoFactorRejected:
                    ErrorMessage = "Invalid 2FA code";
                    TotpCode = "";
                    break;
                case LoginStatus.UnreadableResponse:
                    ErrorMessage = "Authentication server returned an invalid response";
                    break;
            }
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Connection error: {ex.Message}";
        }
        finally
        {
            IsLoggingIn = false;
        }
    }

    [RelayCommand]
    private void Logout()
    {
        _accountService.Logout();
    }
}
