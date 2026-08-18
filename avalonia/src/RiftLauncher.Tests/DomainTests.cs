using RiftLauncher.Core.Domain;
using RiftLauncher.Core.Domain.Account;
using RiftLauncher.Core.Domain.Versions;

namespace RiftLauncher.Tests;

public class VersionNumbersTests
{
    [Theory]
    [InlineData("1.20.0", "1.20.1", -1)]
    [InlineData("1.20.1", "1.20.0", 1)]
    [InlineData("1.20.0", "1.20.0", 0)]
    [InlineData("1.20.0-rc.1", "1.20.0", 0)]
    [InlineData("1.9.0", "1.10.0", -1)]
    [InlineData("2.0.0", "1.99.99", 1)]
    [InlineData("1.20", "1.20.0", 0)]
    public void Compare_OrdersCorrectly(string a, string b, int expectedSign)
    {
        var result = VersionNumbers.Compare(a, b);
        if (expectedSign < 0) result.Should().BeNegative();
        else if (expectedSign > 0) result.Should().BePositive();
        else result.Should().Be(0);
    }
}

public class NamingTests
{
    [Theory]
    [InlineData("My World", "My-World")]
    [InlineData("test<>file", "test-file")]
    [InlineData("  leading  ", "leading")]
    [InlineData("a--b", "a-b")]
    [InlineData("normal", "normal")]
    public void CleanFolderName_SanitizesCorrectly(string input, string expected)
    {
        Naming.CleanFolderName(input).Should().Be(expected);
    }

    [Fact]
    public void FormatTimestampForFilename_FormatsUtc()
    {
        var result = Naming.FormatTimestampForFilename(1723797667000);
        result.Should().MatchRegex(@"^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$");
    }
}

public class GameExecutableTests
{
    [Theory]
    [InlineData("win32", GameOs.Win32)]
    [InlineData("darwin", GameOs.Darwin)]
    [InlineData("linux", GameOs.Linux)]
    [InlineData("freebsd", GameOs.Linux)]
    public void ToGameOs_MapsCorrectly(string platform, GameOs expected)
    {
        GameExecutable.ToGameOs(platform).Should().Be(expected);
    }

    [Fact]
    public void ExpectedExecutables_Win32_ContainsExe()
    {
        var exes = GameExecutable.ExpectedGameExecutables(GameOs.Win32);
        exes.Should().Contain("Vintagestory.exe");
    }

    [Fact]
    public void ExpectedExecutables_Linux_ContainsBoth()
    {
        var exes = GameExecutable.ExpectedGameExecutables(GameOs.Linux);
        exes.Should().Contain("Vintagestory");
        exes.Should().Contain("Vintagestory.exe");
    }

    [Fact]
    public void ExpectedExecutables_Darwin_IsEmpty()
    {
        GameExecutable.ExpectedGameExecutables(GameOs.Darwin).Should().BeEmpty();
    }

    [Fact]
    public void Candidates_Linux_ExeIsMono()
    {
        var candidates = GameExecutable.GameExecutableCandidates(GameOs.Linux);
        var mono = candidates.FirstOrDefault(c => c.FileName == "Vintagestory.exe");
        mono.Should().NotBeNull();
        mono!.LaunchMode.Should().Be(GameExecutableLaunchMode.Mono);
    }
}

public class LaunchPlanBuilderTests
{
    [Fact]
    public void Build_Win32_DirectLaunch()
    {
        var input = new BuildLaunchPlanInput(
            Platform: "win32",
            VersionFolder: "C:/Games/VS",
            FileNames: ["Vintagestory.exe"],
            InstallationPath: "C:/Data/Install1",
            StartParams: "--mods mymod",
            MesaGlThread: false);

        var result = LaunchPlanBuilder.Build(input);
        result.Ok.Should().BeTrue();
        result.Plan!.Command.Should().Contain("Vintagestory.exe");
        result.Plan.Args.Should().Contain("--dataPath=C:/Data/Install1");
        result.Plan.Args.Should().Contain("--mods mymod");
        result.Plan.Env.Should().BeEmpty();
    }

    [Fact]
    public void Build_Linux_NativeWithMesa()
    {
        var input = new BuildLaunchPlanInput(
            Platform: "linux",
            VersionFolder: "/opt/vs",
            FileNames: ["Vintagestory"],
            InstallationPath: "/data/install1",
            StartParams: "",
            MesaGlThread: true);

        var result = LaunchPlanBuilder.Build(input);
        result.Ok.Should().BeTrue();
        result.Plan!.Command.Should().Be("/opt/vs/Vintagestory");
        result.Plan.Env.Should().ContainKey(LaunchPlanBuilder.MesaGlThreadVariable);
    }

    [Fact]
    public void Build_Linux_MonoFallback()
    {
        var input = new BuildLaunchPlanInput(
            Platform: "linux",
            VersionFolder: "/opt/vs",
            FileNames: ["Vintagestory.exe"],
            InstallationPath: "/data/install1",
            StartParams: "",
            MesaGlThread: true);

        var result = LaunchPlanBuilder.Build(input);
        result.Ok.Should().BeTrue();
        result.Plan!.Command.Should().Be("mono");
        result.Plan.Args[0].Should().Contain("Vintagestory.exe");
        result.Plan.Env.Should().BeEmpty();
    }

    [Fact]
    public void Build_Darwin_Unsupported()
    {
        var input = new BuildLaunchPlanInput(
            Platform: "darwin",
            VersionFolder: "/opt/vs",
            FileNames: ["Vintagestory"],
            InstallationPath: "/data/install1",
            StartParams: "",
            MesaGlThread: false);

        var result = LaunchPlanBuilder.Build(input);
        result.Ok.Should().BeFalse();
        result.Reason.Should().Be(BuildLaunchPlanFailure.UnsupportedPlatform);
    }
}

public class LoginProtocolTests
{
    [Fact]
    public void InterpretFirstPass_Success_ReturnsCredentials()
    {
        var response = """
        {
            "valid": 1,
            "playername": "TestPlayer",
            "playeruid": "uid123",
            "sessionkey": "sk123",
            "sessionsignature": "sig456",
            "mptoken": "mp789",
            "entitlements": "vs-full",
            "hostgameserver": true
        }
        """;

        var result = LoginProtocol.InterpretFirstPass("test@example.com", response, false);
        result.Status.Should().Be(LoginStatus.Success);
        result.Credentials.Should().NotBeNull();
        result.Credentials!.Email.Should().Be("test@example.com");
        result.Credentials.PlayerName.Should().Be("TestPlayer");
        result.Credentials.SessionKey.Should().Be("sk123");
    }

    [Fact]
    public void InterpretFirstPass_BadCredentials_RefusesCleanly()
    {
        var response = """{"valid": 0, "reason": "invalidemailorpassword"}""";
        var result = LoginProtocol.InterpretFirstPass("test@example.com", response, false);
        result.Status.Should().Be(LoginStatus.BadCredentials);
    }

    [Fact]
    public void InterpretFirstPass_RequiresTwoFactor_WithoutCode()
    {
        var response = """{"valid": 0, "reason": "requiretotpcode", "prelogintoken": "tok123"}""";
        var result = LoginProtocol.InterpretFirstPass("test@example.com", response, false);
        result.Status.Should().Be(LoginStatus.NeedsTwoFactor);
    }

    [Fact]
    public void InterpretFirstPass_RequiresTwoFactor_WithCode()
    {
        var response = """{"valid": 0, "reason": "requiretotpcode", "prelogintoken": "tok123"}""";
        var result = LoginProtocol.InterpretFirstPass("test@example.com", response, true);
        result.Status.Should().Be(LoginStatus.NeedsTwoFactor);
        result.PreLoginToken.Should().Be("tok123");
    }

    [Fact]
    public void InterpretSecondPass_WrongCode()
    {
        var response = """{"valid": 0, "reason": "wrongtotpcode"}""";
        var result = LoginProtocol.InterpretSecondPass("test@example.com", response);
        result.Status.Should().Be(LoginStatus.TwoFactorRejected);
    }

    [Fact]
    public void InterpretFirstPass_InvalidJson_Unreadable()
    {
        var result = LoginProtocol.InterpretFirstPass("test@example.com", "not json", false);
        result.Status.Should().Be(LoginStatus.UnreadableResponse);
    }
}
