using RiftLauncher.Core.Domain.Account;

namespace RiftLauncher.Tests.Domain;

public class LoginProtocolExtendedTests
{
    [Fact]
    public void InterpretFirstPass_ValidLogin_ReturnsSuccess()
    {
        var json = """
        {
            "valid": "1",
            "playername": "TestPlayer",
            "playeruid": "uid123",
            "sessionkey": "key456",
            "sessionsignature": "sig789",
            "mptoken": "mp000",
            "entitlements": "game",
            "hostgameserver": 1
        }
        """;

        var result = LoginProtocol.InterpretFirstPass("test@example.com", json, false);

        Assert.Equal(LoginStatus.Success, result.Status);
        Assert.NotNull(result.Credentials);
        Assert.Equal("TestPlayer", result.Credentials.PlayerName);
        Assert.Equal("uid123", result.Credentials.PlayerUid);
        Assert.Equal("key456", result.Credentials.SessionKey);
        Assert.True(result.Credentials.HostGameServer);
    }

    [Fact]
    public void InterpretFirstPass_RequiresTwoFactor_ReturnsNeedsTwoFactor()
    {
        var json = """{"valid": 0, "reason": "requiretotpcode", "prelogintoken": "pre123"}""";

        var result = LoginProtocol.InterpretFirstPass("test@example.com", json, false);

        Assert.Equal(LoginStatus.NeedsTwoFactor, result.Status);
        Assert.Null(result.PreLoginToken);
    }

    [Fact]
    public void InterpretFirstPass_BadCredentials_ReturnsBadCredentials()
    {
        var json = """{"valid": 0, "reason": "badlogin"}""";

        var result = LoginProtocol.InterpretFirstPass("test@example.com", json, false);

        Assert.Equal(LoginStatus.BadCredentials, result.Status);
    }

    [Fact]
    public void InterpretSecondPass_WrongTotp_ReturnsTwoFactorRejected()
    {
        var json = """{"valid": "0", "reason": "wrongtotpcode"}""";

        var result = LoginProtocol.InterpretSecondPass("test@example.com", json);

        Assert.Equal(LoginStatus.TwoFactorRejected, result.Status);
    }

    [Fact]
    public void InterpretFirstPass_InvalidJson_ReturnsUnreadable()
    {
        var result = LoginProtocol.InterpretFirstPass("test@example.com", "not json", false);
        Assert.Equal(LoginStatus.UnreadableResponse, result.Status);
    }
}
