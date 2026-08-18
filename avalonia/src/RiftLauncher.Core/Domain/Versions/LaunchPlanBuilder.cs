namespace RiftLauncher.Core.Domain.Versions;

public sealed record GameLaunchPlan(
    string Command,
    IReadOnlyList<string> Args,
    string ExecutablePath,
    IReadOnlyDictionary<string, string> Env,
    string Cwd);

public enum BuildLaunchPlanFailure
{
    UnsupportedPlatform,
    NoExecutable
}

public sealed record BuildLaunchPlanResult(bool Ok, GameLaunchPlan? Plan = null, BuildLaunchPlanFailure? Reason = null)
{
    public static BuildLaunchPlanResult Success(GameLaunchPlan plan) => new(true, plan);
    public static BuildLaunchPlanResult Failure(BuildLaunchPlanFailure reason) => new(false, Reason: reason);
}

public sealed record BuildLaunchPlanInput(
    string Platform,
    string VersionFolder,
    IReadOnlyList<string> FileNames,
    string InstallationPath,
    string StartParams,
    bool MesaGlThread);

public static class LaunchPlanBuilder
{
    public const string MesaGlThreadVariable = "mesa_glthread";

    public static BuildLaunchPlanResult Build(BuildLaunchPlanInput input)
    {
        var os = LaunchableOs(input.Platform);
        if (os is null) return BuildLaunchPlanResult.Failure(BuildLaunchPlanFailure.UnsupportedPlatform);

        var candidate = GameExecutable.GameExecutableCandidates(os.Value)
            .FirstOrDefault(c => input.FileNames.Contains(c.FileName));
        if (candidate is null) return BuildLaunchPlanResult.Failure(BuildLaunchPlanFailure.NoExecutable);

        var executablePath = Path.Combine(input.VersionFolder, candidate.FileName);
        var gameArgs = new List<string> { $"--dataPath={input.InstallationPath}", input.StartParams };
        var runsUnderMono = candidate.LaunchMode == GameExecutableLaunchMode.Mono;

        var env = new Dictionary<string, string>();
        if (!runsUnderMono && os == GameOs.Linux && input.MesaGlThread)
            env[MesaGlThreadVariable] = "true";

        return BuildLaunchPlanResult.Success(new GameLaunchPlan(
            Command: runsUnderMono ? "mono" : executablePath,
            Args: runsUnderMono ? [executablePath, .. gameArgs] : gameArgs,
            ExecutablePath: executablePath,
            Env: env,
            Cwd: input.VersionFolder));
    }

    private static GameOs? LaunchableOs(string platform)
    {
        return platform switch
        {
            "linux" => GameOs.Linux,
            "win32" => GameOs.Win32,
            _ => null
        };
    }
}
