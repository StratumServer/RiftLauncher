using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;

namespace RiftLauncher.Core.Services;

public sealed record ModAuthor(string UserId, string Name);
public sealed record ModGameVersion(string TagId, string Name);
public sealed record ModTag(string TagId, string Name, string Color);

public sealed record ModListEntry(
    string ModId,
    string AssetId,
    string Name,
    string Summary,
    string Author,
    string LogoUrl,
    int Downloads,
    int Follows,
    int Comments,
    string Side,
    string LastReleased,
    IReadOnlyList<string> Tags,
    IReadOnlyList<string> GameVersions);

public sealed record ModDetail(
    string ModId,
    string AssetId,
    string Name,
    string Description,
    string Author,
    string LogoUrl,
    int Downloads,
    int Follows,
    string Side,
    string LastReleased,
    IReadOnlyList<ModRelease> Releases);

public sealed record ModRelease(
    string ReleaseId,
    string ModVersion,
    string FileName,
    string MainFile,
    IReadOnlyList<string> GameVersions,
    DateTime Created);

public interface IModDbService
{
    Task<IReadOnlyList<ModListEntry>> QueryModsAsync(ModQueryParams query, CancellationToken ct = default);
    Task<ModDetail?> GetModDetailsAsync(string assetId, CancellationToken ct = default);
    Task<string> DownloadModAsync(string fileUrl, string outputFolder, IProgress<double>? progress = null, CancellationToken ct = default);
}

public sealed record ModQueryParams(
    string? TextFilter = null,
    string? AuthorId = null,
    IReadOnlyList<string>? GameVersionTagIds = null,
    IReadOnlyList<string>? TagIds = null,
    string? Side = null,
    string OrderBy = "follows",
    string OrderDirection = "desc");

public sealed class ModDbService : IModDbService
{
    private const string ModDbApi = "https://mods.vintagestory.at/api";
    private readonly HttpClient _httpClient;
    private readonly ILogger<ModDbService> _logger;

    public ModDbService(HttpClient httpClient, ILogger<ModDbService> logger)
    {
        _httpClient = httpClient;
        _logger = logger;
    }

    public async Task<IReadOnlyList<ModListEntry>> QueryModsAsync(ModQueryParams query, CancellationToken ct = default)
    {
        try
        {
            var filters = new List<string>();
            if (!string.IsNullOrEmpty(query.TextFilter) && query.TextFilter.Length > 1)
                filters.Add($"text={Uri.EscapeDataString(query.TextFilter)}");
            if (!string.IsNullOrEmpty(query.AuthorId))
                filters.Add($"author={Uri.EscapeDataString(query.AuthorId)}");
            if (query.GameVersionTagIds is { Count: > 0 })
                foreach (var v in query.GameVersionTagIds)
                    filters.Add($"gameversions[]={Uri.EscapeDataString(v)}");
            if (query.TagIds is { Count: > 0 })
                foreach (var t in query.TagIds)
                    filters.Add($"tagids[]={Uri.EscapeDataString(t)}");
            if (!string.IsNullOrEmpty(query.Side) && query.Side != "any")
                filters.Add($"side={Uri.EscapeDataString(query.Side)}");
            filters.Add($"orderby={query.OrderBy}");
            filters.Add($"orderdirection={query.OrderDirection}");

            var url = $"{ModDbApi}/mods?{string.Join("&", filters)}";
            var json = await _httpClient.GetStringAsync(url, ct);

            return ParseModList(json);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to query ModDB");
            return [];
        }
    }

    public async Task<ModDetail?> GetModDetailsAsync(string assetId, CancellationToken ct = default)
    {
        try
        {
            var url = $"{ModDbApi}/mod/{Uri.EscapeDataString(assetId)}";
            var json = await _httpClient.GetStringAsync(url, ct);
            return ParseModDetail(json);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to get mod details for {AssetId}", assetId);
            return null;
        }
    }

    public async Task<string> DownloadModAsync(string fileUrl, string outputFolder, IProgress<double>? progress = null, CancellationToken ct = default)
    {
        Directory.CreateDirectory(outputFolder);
        var fileName = Path.GetFileName(new Uri(fileUrl).AbsolutePath);
        if (string.IsNullOrEmpty(fileName)) fileName = "mod.zip";
        var outputPath = Path.Combine(outputFolder, fileName);

        using var response = await _httpClient.GetAsync(fileUrl, HttpCompletionOption.ResponseHeadersRead, ct);
        response.EnsureSuccessStatusCode();

        var totalBytes = response.Content.Headers.ContentLength;
        await using var contentStream = await response.Content.ReadAsStreamAsync(ct);
        await using var fileStream = new FileStream(outputPath, FileMode.Create, FileAccess.Write, FileShare.None, 81920, true);

        var buffer = new byte[81920];
        long bytesRead = 0;
        int read;

        while ((read = await contentStream.ReadAsync(buffer, ct)) > 0)
        {
            await fileStream.WriteAsync(buffer.AsMemory(0, read), ct);
            bytesRead += read;
            if (totalBytes > 0)
                progress?.Report((double)bytesRead / totalBytes.Value * 100);
        }

        progress?.Report(100);
        return outputPath;
    }

    private static IReadOnlyList<ModListEntry> ParseModList(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        if (!root.TryGetProperty("statuscode", out var status) || status.GetString() != "200")
            return [];

        if (!root.TryGetProperty("mods", out var modsEl))
            return [];

        var entries = new List<ModListEntry>();
        foreach (var mod in modsEl.EnumerateArray())
        {
            try
            {
                entries.Add(new ModListEntry(
                    ModId: GetString(mod, "modid"),
                    AssetId: GetString(mod, "assetid"),
                    Name: GetString(mod, "name"),
                    Summary: GetString(mod, "summary"),
                    Author: GetString(mod, "author"),
                    LogoUrl: GetString(mod, "logo"),
                    Downloads: GetInt(mod, "downloads"),
                    Follows: GetInt(mod, "follows"),
                    Comments: GetInt(mod, "comments"),
                    Side: GetString(mod, "side"),
                    LastReleased: GetString(mod, "lastreleased"),
                    Tags: GetStringArray(mod, "tags"),
                    GameVersions: GetStringArray(mod, "gameversions")));
            }
            catch
            {
                // Skip malformed entries
            }
        }

        return entries;
    }

    private static ModDetail? ParseModDetail(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        if (!root.TryGetProperty("statuscode", out var status) || status.GetString() != "200")
            return null;

        if (!root.TryGetProperty("mod", out var mod))
            return null;

        var releases = new List<ModRelease>();
        if (mod.TryGetProperty("releases", out var releasesEl))
        {
            foreach (var rel in releasesEl.EnumerateArray())
            {
                try
                {
                    releases.Add(new ModRelease(
                        ReleaseId: GetString(rel, "releaseid"),
                        ModVersion: GetString(rel, "modversion"),
                        FileName: GetString(rel, "filename"),
                        MainFile: GetString(rel, "mainfile"),
                        GameVersions: GetStringArray(rel, "tags"),
                        Created: rel.TryGetProperty("created", out var created)
                            ? DateTime.TryParse(created.GetString(), out var dt) ? dt : DateTime.MinValue
                            : DateTime.MinValue));
                }
                catch { }
            }
        }

        return new ModDetail(
            ModId: GetString(mod, "modid"),
            AssetId: GetString(mod, "assetid"),
            Name: GetString(mod, "name"),
            Description: GetString(mod, "text"),
            Author: GetString(mod, "author"),
            LogoUrl: GetString(mod, "logo"),
            Downloads: GetInt(mod, "downloads"),
            Follows: GetInt(mod, "follows"),
            Side: GetString(mod, "side"),
            LastReleased: GetString(mod, "lastreleased"),
            Releases: releases);
    }

    private static string GetString(JsonElement el, string prop)
        => el.TryGetProperty(prop, out var val) ? val.GetString() ?? "" : "";

    private static int GetInt(JsonElement el, string prop)
        => el.TryGetProperty(prop, out var val) && val.TryGetInt32(out var i) ? i : 0;

    private static IReadOnlyList<string> GetStringArray(JsonElement el, string prop)
    {
        if (!el.TryGetProperty(prop, out var arr) || arr.ValueKind != JsonValueKind.Array)
            return [];
        return arr.EnumerateArray()
            .Select(e => e.GetString()?.Trim() ?? "")
            .Where(s => s.Length > 0)
            .ToList();
    }
}
