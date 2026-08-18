using System.Text.Json;

namespace RiftLauncher.Core.Domain.Account;

public sealed record AccountCredentials(
    string Email,
    string PlayerName,
    string PlayerUid,
    string? PlayerEntitlements,
    bool HostGameServer,
    string SessionKey,
    string SessionSignature,
    string MpToken);

public enum LoginStatus
{
    Success,
    NeedsTwoFactor,
    BadCredentials,
    TwoFactorRejected,
    UnreadableResponse
}

public sealed record LoginResult(LoginStatus Status, AccountCredentials? Credentials = null, string? PreLoginToken = null, string? Diagnosis = null);

public static class LoginProtocol
{
    private const string RequireTwoFactorReason = "requiretotpcode";
    private const string WrongTwoFactorReason = "wrongtotpcode";

    public static LoginResult InterpretFirstPass(string email, string rawResponse, bool twoFactorCodeProvided)
    {
        var body = ReadBody(rawResponse);
        if (body is null) return new LoginResult(LoginStatus.UnreadableResponse);

        var bodyValue = body.Value;
        if (!Refused(bodyValue))
            return Establish(email, bodyValue);

        var reason = RefusalReason(bodyValue);
        if (reason != RequireTwoFactorReason)
            return new LoginResult(LoginStatus.BadCredentials);

        if (!twoFactorCodeProvided)
            return new LoginResult(LoginStatus.NeedsTwoFactor);

        var preLoginToken = bodyValue.TryGetProperty("prelogintoken", out var tokenEl) && tokenEl.ValueKind == JsonValueKind.String
            ? tokenEl.GetString()
            : null;

        return new LoginResult(LoginStatus.NeedsTwoFactor, PreLoginToken: preLoginToken);
    }

    public static LoginResult InterpretSecondPass(string email, string rawResponse)
    {
        var body = ReadBody(rawResponse);
        if (body is null) return new LoginResult(LoginStatus.UnreadableResponse);

        var bodyValue = body.Value;
        if (!Refused(bodyValue))
            return Establish(email, bodyValue);

        return RefusalReason(bodyValue) == WrongTwoFactorReason
            ? new LoginResult(LoginStatus.TwoFactorRejected)
            : new LoginResult(LoginStatus.BadCredentials);
    }

    private static JsonElement? ReadBody(string rawResponse)
    {
        try
        {
            var doc = JsonDocument.Parse(rawResponse);
            return doc.RootElement.ValueKind == JsonValueKind.Object ? doc.RootElement : null;
        }
        catch
        {
            return null;
        }
    }

    private static bool Refused(JsonElement body)
    {
        if (!body.TryGetProperty("valid", out var valid)) return false;
        return valid.ValueKind switch
        {
            JsonValueKind.Number => valid.GetInt32() == 0,
            JsonValueKind.String => valid.GetString() == "0",
            JsonValueKind.False => true,
            _ => false
        };
    }

    private static string RefusalReason(JsonElement body)
    {
        return body.TryGetProperty("reason", out var reason) && reason.ValueKind == JsonValueKind.String
            ? reason.GetString() ?? ""
            : "";
    }

    private static LoginResult Establish(string email, JsonElement body)
    {
        try
        {
            var playerName = GetRequiredString(body, "playername");
            var playerUid = GetRequiredString(body, "playeruid");
            var sessionKey = GetRequiredString(body, "sessionkey");
            var sessionSignature = GetRequiredString(body, "sessionsignature");
            var mpToken = GetRequiredString(body, "mptoken");

            var entitlements = body.TryGetProperty("entitlements", out var entEl) && entEl.ValueKind == JsonValueKind.String
                ? entEl.GetString()
                : null;

            var hostGameServer = body.TryGetProperty("hostgameserver", out var hostEl) &&
                                 (hostEl.ValueKind == JsonValueKind.True ||
                                  (hostEl.ValueKind == JsonValueKind.Number && hostEl.GetInt32() == 1));

            var credentials = new AccountCredentials(
                Email: email,
                PlayerName: playerName,
                PlayerUid: playerUid,
                PlayerEntitlements: entitlements,
                HostGameServer: hostGameServer,
                SessionKey: sessionKey,
                SessionSignature: sessionSignature,
                MpToken: mpToken);

            return new LoginResult(LoginStatus.Success, credentials);
        }
        catch (Exception ex)
        {
            return new LoginResult(LoginStatus.UnreadableResponse, Diagnosis: ex.Message);
        }
    }

    private static string GetRequiredString(JsonElement body, string field)
    {
        if (!body.TryGetProperty(field, out var el) || el.ValueKind != JsonValueKind.String)
            throw new InvalidOperationException($"Missing or invalid field: {field}");
        var value = el.GetString();
        if (string.IsNullOrEmpty(value))
            throw new InvalidOperationException($"Empty field: {field}");
        return value;
    }
}
