namespace RiftLauncher.Core.Domain.Versions;

public enum GameOs
{
    Win32,
    Darwin,
    Linux
}

public enum GameExecutableLaunchMode
{
    Direct,
    Mono
}

public sealed record GameExecutableCandidate(string FileName, GameExecutableLaunchMode LaunchMode);

public static class GameExecutable
{
    public static GameOs ToGameOs(string platform)
    {
        return platform switch
        {
            "win32" => GameOs.Win32,
            "darwin" => GameOs.Darwin,
            _ => GameOs.Linux
        };
    }

    public static IReadOnlyList<string> ExpectedGameExecutables(GameOs os)
    {
        return os switch
        {
            GameOs.Win32 => ["Vintagestory.exe"],
            GameOs.Linux => ["Vintagestory", "Vintagestory.exe"],
            GameOs.Darwin => [],
            _ => []
        };
    }

    public static IReadOnlyList<GameExecutableCandidate> GameExecutableCandidates(GameOs os)
    {
        return ExpectedGameExecutables(os)
            .Select(fileName => new GameExecutableCandidate(
                fileName,
                os == GameOs.Linux && fileName.EndsWith(".exe") ? GameExecutableLaunchMode.Mono : GameExecutableLaunchMode.Direct))
            .ToList();
    }
}
