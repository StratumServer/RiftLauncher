using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;

namespace RiftLauncher.Core.Services;

using Domain.Config;

public interface IConfigService
{
    Task<AppConfig> GetConfigAsync();
    Task<bool> SaveConfigAsync(AppConfig config);
    string ConfigPath { get; }
}

public sealed class ConfigService : IConfigService
{
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private static readonly JsonSerializerOptions DeserializerOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    private readonly ILogger<ConfigService> _logger;
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private AppConfig? _cache;

    public string ConfigPath { get; }

    public ConfigService(ILogger<ConfigService> logger, string? configPath = null)
    {
        _logger = logger;
        ConfigPath = configPath ?? GetDefaultConfigPath();
    }

    public async Task<AppConfig> GetConfigAsync()
    {
        if (_cache is not null)
            return _cache;

        try
        {
            if (!File.Exists(ConfigPath))
            {
                _logger.LogInformation("Config not found at {Path}. Creating default", ConfigPath);
                var defaultConfig = CreateDefaultConfig();
                await SaveConfigAsync(defaultConfig);
                return defaultConfig;
            }

            var json = await File.ReadAllTextAsync(ConfigPath);
            var node = JsonNode.Parse(json);

            var migration = ConfigMigrations.MigrateDocument(node);
            LogMigration(migration);

            var config = DeserializeConfig(migration.Doc);
            NormalizeConfig(config);
            _cache = config;

            if (migration.Outcome == ConfigMigrationOutcome.Migrated)
                await SaveConfigAsync(config);

            return config;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error reading config at {Path}. Using defaults", ConfigPath);
            var defaultConfig = CreateDefaultConfig();
            await SaveConfigAsync(defaultConfig);
            return defaultConfig;
        }
    }

    public async Task<bool> SaveConfigAsync(AppConfig config)
    {
        NormalizeConfig(config);
        _cache = config;

        await _writeLock.WaitAsync();
        try
        {
            var dir = Path.GetDirectoryName(ConfigPath);
            if (!string.IsNullOrEmpty(dir))
                Directory.CreateDirectory(dir);

            var tempPath = $"{ConfigPath}.{Environment.ProcessId}.{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}.tmp";

            try
            {
                var json = JsonSerializer.Serialize(config, SerializerOptions);
                await File.WriteAllTextAsync(tempPath, json);
                File.Move(tempPath, ConfigPath, overwrite: true);
                return true;
            }
            finally
            {
                if (File.Exists(tempPath))
                    File.Delete(tempPath);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error saving config to {Path}", ConfigPath);
            return false;
        }
        finally
        {
            _writeLock.Release();
        }
    }

    private static AppConfig DeserializeConfig(JsonNode? node)
    {
        if (node is null)
            return CreateDefaultConfig();

        try
        {
            return node.Deserialize<AppConfig>(DeserializerOptions) ?? CreateDefaultConfig();
        }
        catch
        {
            return CreateDefaultConfig();
        }
    }

    private static void NormalizeConfig(AppConfig config)
    {
        config.SchemaVersion = ConfigMigrations.ClampSchema(config.SchemaVersion);
        config.Window.Width = Math.Clamp(config.Window.Width, 1024, 8192);
        config.Window.Height = Math.Clamp(config.Window.Height, 600, 8192);
        config.Window.X = Math.Clamp(config.Window.X, -100_000, 100_000);
        config.Window.Y = Math.Clamp(config.Window.Y, -100_000, 100_000);

        config.Installations = config.Installations
            .Where(i => !string.IsNullOrEmpty(i.Id) && !string.IsNullOrEmpty(i.Path))
            .Take(1000)
            .ToList();

        foreach (var installation in config.Installations)
        {
            installation.BackupsLimit = Math.Clamp(installation.BackupsLimit, 0, 100);
            installation.CompressionLevel = Math.Clamp(installation.CompressionLevel, 0, 9);
            installation.Backups = installation.Backups
                .Where(b => !string.IsNullOrEmpty(b.Id) && !string.IsNullOrEmpty(b.Path))
                .Take(100)
                .ToList();
        }

        config.GameVersions = config.GameVersions
            .Where(v => !string.IsNullOrEmpty(v.Version) && !string.IsNullOrEmpty(v.Path))
            .Take(1000)
            .ToList();

        config.CustomIcons = config.CustomIcons
            .Where(i => !string.IsNullOrEmpty(i.Id) && !string.IsNullOrEmpty(i.Name) &&
                        i.Icon.EndsWith(".png", StringComparison.OrdinalIgnoreCase))
            .Take(1000)
            .ToList();

        config.FavMods = config.FavMods.Take(10_000).ToList();
    }

    private static AppConfig CreateDefaultConfig()
    {
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        return new AppConfig
        {
            SchemaVersion = ConfigMigrations.CurrentSchema,
            DefaultInstallationsFolder = Path.Combine(appData, "VSLInstallations"),
            DefaultVersionsFolder = Path.Combine(appData, "VSLGameVersions"),
            BackupsFolder = Path.Combine(appData, "VSLBackups")
        };
    }

    private static string GetDefaultConfigPath()
    {
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        return Path.Combine(appData, "rift-launcher", "config.json");
    }

    private void LogMigration(ConfigMigrationResult result)
    {
        switch (result.Outcome)
        {
            case ConfigMigrationOutcome.Migrated:
                var steps = string.Join(", ", result.Applied.Select(a => $"{a.FromSchema}->{a.ToSchema}"));
                _logger.LogInformation("Config migrated from {Era} era to schema {Schema} ({Steps})",
                    result.Detected.Era, result.Schema, steps);
                break;
            case ConfigMigrationOutcome.FutureSchema:
                _logger.LogWarning("Config carries schema {Schema}, newer than {Current}. Reading as-is",
                    result.Schema, ConfigMigrations.CurrentSchema);
                break;
            case ConfigMigrationOutcome.ChainBroken:
                _logger.LogWarning("No migration continues past schema {Schema}. Reading as-is", result.Schema);
                break;
            case ConfigMigrationOutcome.MigrationFailed:
                _logger.LogError("Config migration failed at schema {Schema}. Reading as-is", result.Schema);
                break;
            case ConfigMigrationOutcome.Unreadable:
                _logger.LogWarning("Config is not a valid object. Falling back to defaults");
                break;
        }
    }
}
