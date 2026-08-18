using Microsoft.Extensions.Logging;
using RiftLauncher.Core.Domain.Account;

namespace RiftLauncher.Core.Services;

public interface IAccountService
{
    Task<LoginResult> LoginAsync(string email, string password, CancellationToken ct = default);
    Task<LoginResult> LoginWithTwoFactorAsync(string email, string password, string totpCode, string? preLoginToken, CancellationToken ct = default);
    void Logout();
    AccountCredentials? CurrentSession { get; }
    bool IsLoggedIn { get; }
    event Action? SessionChanged;
}

public sealed class AccountService : IAccountService
{
    private const string AuthUrl = "https://auth3.vintagestory.at/api/v1/account/login";
    private readonly HttpClient _httpClient;
    private readonly IConfigService _configService;
    private readonly ILogger<AccountService> _logger;

    public AccountCredentials? CurrentSession { get; private set; }
    public bool IsLoggedIn => CurrentSession != null;
    public event Action? SessionChanged;

    public AccountService(HttpClient httpClient, IConfigService configService, ILogger<AccountService> logger)
    {
        _httpClient = httpClient;
        _configService = configService;
        _logger = logger;

        _ = RestoreSessionAsync();
    }

    private async Task RestoreSessionAsync()
    {
        var config = await _configService.GetConfigAsync();
        if (config.Account is { PlayerName: not null })
        {
            CurrentSession = new AccountCredentials(
                Email: config.Account.Email ?? "",
                PlayerName: config.Account.PlayerName,
                PlayerUid: config.Account.PlayerUid ?? "",
                PlayerEntitlements: config.Account.PlayerEntitlements,
                HostGameServer: config.Account.HostGameServer,
                SessionKey: "",
                SessionSignature: "",
                MpToken: "");
            SessionChanged?.Invoke();
        }
    }

    public async Task<LoginResult> LoginAsync(string email, string password, CancellationToken ct = default)
    {
        var content = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["email"] = email,
            ["password"] = password
        });

        var response = await _httpClient.PostAsync(AuthUrl, content, ct);
        var rawResponse = await response.Content.ReadAsStringAsync(ct);

        var result = LoginProtocol.InterpretFirstPass(email, rawResponse, twoFactorCodeProvided: false);

        if (result.Status == LoginStatus.Success && result.Credentials != null)
            await EstablishSession(result.Credentials);

        return result;
    }

    public async Task<LoginResult> LoginWithTwoFactorAsync(string email, string password, string totpCode, string? preLoginToken, CancellationToken ct = default)
    {
        var fields = new Dictionary<string, string>
        {
            ["email"] = email,
            ["password"] = password,
            ["totpcode"] = totpCode
        };

        if (!string.IsNullOrEmpty(preLoginToken))
            fields["prelogintoken"] = preLoginToken;

        var content = new FormUrlEncodedContent(fields);
        var response = await _httpClient.PostAsync(AuthUrl, content, ct);
        var rawResponse = await response.Content.ReadAsStringAsync(ct);

        var result = LoginProtocol.InterpretSecondPass(email, rawResponse);

        if (result.Status == LoginStatus.Success && result.Credentials != null)
            await EstablishSession(result.Credentials);

        return result;
    }

    public void Logout()
    {
        CurrentSession = null;
        SessionChanged?.Invoke();
        _ = ClearSessionAsync();
    }

    private async Task EstablishSession(AccountCredentials credentials)
    {
        CurrentSession = credentials;
        SessionChanged?.Invoke();

        var config = await _configService.GetConfigAsync();
        config.Account = new Domain.Config.AccountPublic
        {
            Email = credentials.Email,
            PlayerName = credentials.PlayerName,
            PlayerUid = credentials.PlayerUid,
            PlayerEntitlements = credentials.PlayerEntitlements,
            HostGameServer = credentials.HostGameServer
        };
        await _configService.SaveConfigAsync(config);
    }

    private async Task ClearSessionAsync()
    {
        var config = await _configService.GetConfigAsync();
        config.Account = null;
        await _configService.SaveConfigAsync(config);
    }
}
