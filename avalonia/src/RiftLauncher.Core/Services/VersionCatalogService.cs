using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;

namespace RiftLauncher.Core.Services;

public sealed record VersionCatalogEntry(
    string Version,
    string Type,
    string WindowsUrl,
    string WindowsFileName,
    string LinuxUrl,
    string LinuxFileName,
    string MacUrl,
    string MacFileName);

public interface IVersionCatalogService
{
    Task<IReadOnlyList<VersionCatalogEntry>> FetchCatalogAsync(CancellationToken ct = default);
}

public sealed class VersionCatalogService : IVersionCatalogService
{
    private const string VsApi = "https://api.vintagestory.at";
    private readonly HttpClient _httpClient;
    private readonly ILogger<VersionCatalogService> _logger;

    public VersionCatalogService(HttpClient httpClient, ILogger<VersionCatalogService> logger)
    {
        _httpClient = httpClient;
        _logger = logger;
    }

    public async Task<IReadOnlyList<VersionCatalogEntry>> FetchCatalogAsync(CancellationToken ct = default)
    {
        var stableTask = FetchJsonAsync($"{VsApi}/stable.json", ct);
        var unstableTask = FetchJsonAsync($"{VsApi}/unstable.json", ct);

        var stable = await stableTask;
        var unstable = await unstableTask;

        var merged = new Dictionary<string, JsonElement>();
        MergeInto(merged, unstable);
        MergeInto(merged, stable);

        var entries = new List<VersionCatalogEntry>(merged.Count);
        foreach (var (version, platforms) in merged)
        {
            var type = DeriveType(version);
            var win = ExtractBuild(platforms, "windows");
            var linux = ExtractBuild(platforms, "linux");
            var mac = ExtractBuild(platforms, "mac-arm64") ?? ExtractBuild(platforms, "mac-x64");

            entries.Add(new VersionCatalogEntry(
                version, type,
                win?.Url ?? "", win?.FileName ?? "",
                linux?.Url ?? "", linux?.FileName ?? "",
                mac?.Url ?? "", mac?.FileName ?? ""));
        }

        entries.Sort((a, b) => CompareVersionsDesc(a.Version, b.Version));
        return entries;
    }

    private async Task<Dictionary<string, JsonElement>> FetchJsonAsync(string url, CancellationToken ct)
    {
        try
        {
            var json = await _httpClient.GetStringAsync(url, ct);
            return JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json) ?? [];
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to fetch version catalog from {Url}", url);
            return [];
        }
    }

    private static void MergeInto(Dictionary<string, JsonElement> target, Dictionary<string, JsonElement> source)
    {
        foreach (var (key, value) in source)
            target[key] = value;
    }

    private static string DeriveType(string version)
    {
        if (version.Contains("-rc")) return "rc";
        if (version.Contains("-pre")) return "pre";
        return "stable";
    }

    private static (string Url, string FileName)? ExtractBuild(JsonElement platforms, string platformKey)
    {
        if (!platforms.TryGetProperty(platformKey, out var platform))
            return null;

        var fileName = platform.TryGetProperty("filename", out var fn) ? fn.GetString() : null;
        var url = "";
        if (platform.TryGetProperty("urls", out var urls) && urls.TryGetProperty("cdn", out var cdn))
            url = cdn.GetString() ?? "";

        if (string.IsNullOrEmpty(url) || string.IsNullOrEmpty(fileName))
            return null;

        return (url, fileName);
    }

    private static int CompareVersionsDesc(string a, string b)
    {
        var partsA = StripPreRelease(a).Split('.');
        var partsB = StripPreRelease(b).Split('.');
        var len = Math.Max(partsA.Length, partsB.Length);

        for (int i = 0; i < len; i++)
        {
            var numA = i < partsA.Length && int.TryParse(partsA[i], out var va) ? va : 0;
            var numB = i < partsB.Length && int.TryParse(partsB[i], out var vb) ? vb : 0;
            if (numA != numB) return numB.CompareTo(numA);
        }

        return string.Compare(b, a, StringComparison.Ordinal);
    }

    private static string StripPreRelease(string version)
    {
        var idx = version.IndexOf('-');
        return idx >= 0 ? version[..idx] : version;
    }
}
