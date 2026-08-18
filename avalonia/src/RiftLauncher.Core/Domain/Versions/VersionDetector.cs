using System.Diagnostics;

namespace RiftLauncher.Core.Domain.Versions;

public sealed record DetectVersionInput(string Platform, string Folder, IReadOnlyList<string> FileNames);

public enum DetectVersionFailure
{
    NoExecutable,
    ProbeFailed,
    UnreadableVersion
}

public sealed record DetectVersionResult(bool Ok, string? Version = null, DetectVersionFailure? Reason = null)
{
    public static DetectVersionResult Success(string version) => new(true, version);
    public static DetectVersionResult Failure(DetectVersionFailure reason) => new(false, Reason: reason);
}

public static class VersionDetector
{
    public static async Task<DetectVersionResult> DetectAsync(DetectVersionInput input, TimeSpan? timeout = null)
    {
        var os = GameExecutable.ToGameOs(input.Platform);
        var candidate = GameExecutable.GameExecutableCandidates(os)
            .FirstOrDefault(c => input.FileNames.Contains(c.FileName));

        if (candidate is null)
            return DetectVersionResult.Failure(DetectVersionFailure.NoExecutable);

        var executablePath = Path.Combine(input.Folder, candidate.FileName);
        var probeTimeout = timeout ?? TimeSpan.FromSeconds(10);

        try
        {
            var (command, args) = candidate.LaunchMode == GameExecutableLaunchMode.Mono
                ? ("mono", $"\"{executablePath}\" -v")
                : (executablePath, "-v");

            using var process = new Process();
            process.StartInfo = new ProcessStartInfo
            {
                FileName = command,
                Arguments = args,
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = input.Folder
            };

            process.Start();
            var stdout = await process.StandardOutput.ReadToEndAsync();
            await process.WaitForExitAsync().WaitAsync(probeTimeout);

            var version = stdout.Trim();
            return string.IsNullOrEmpty(version)
                ? DetectVersionResult.Failure(DetectVersionFailure.UnreadableVersion)
                : DetectVersionResult.Success(version);
        }
        catch
        {
            return DetectVersionResult.Failure(DetectVersionFailure.ProbeFailed);
        }
    }
}
