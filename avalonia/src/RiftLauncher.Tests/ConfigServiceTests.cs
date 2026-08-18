using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using RiftLauncher.Core.Domain.Config;
using RiftLauncher.Core.Services;

namespace RiftLauncher.Tests;

public class ConfigServiceTests : IDisposable
{
    private readonly string _tempDir;
    private readonly string _configPath;
    private readonly ConfigService _service;

    public ConfigServiceTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), $"rift-test-{Guid.NewGuid():N}");
        Directory.CreateDirectory(_tempDir);
        _configPath = Path.Combine(_tempDir, "config.json");
        _service = new ConfigService(NullLogger<ConfigService>.Instance, _configPath);
    }

    public void Dispose()
    {
        if (Directory.Exists(_tempDir))
            Directory.Delete(_tempDir, recursive: true);
    }

    [Fact]
    public async Task GetConfig_NoFile_CreatesDefault()
    {
        var config = await _service.GetConfigAsync();
        config.Should().NotBeNull();
        config.SchemaVersion.Should().Be(ConfigMigrations.CurrentSchema);
        config.Installations.Should().BeEmpty();
        File.Exists(_configPath).Should().BeTrue();
    }

    [Fact]
    public async Task SaveConfig_RoundTrips()
    {
        var config = new AppConfig
        {
            SchemaVersion = 2,
            DefaultInstallationsFolder = "/test/installations",
            DefaultVersionsFolder = "/test/versions",
            BackupsFolder = "/test/backups",
            Installations =
            [
                new Installation
                {
                    Id = "test-1",
                    Name = "Test Install",
                    Path = "/games/vs",
                    Version = "1.20.0"
                }
            ]
        };

        var saved = await _service.SaveConfigAsync(config);
        saved.Should().BeTrue();

        var reloaded = new ConfigService(NullLogger<ConfigService>.Instance, _configPath);
        var loaded = await reloaded.GetConfigAsync();
        loaded.DefaultInstallationsFolder.Should().Be("/test/installations");
        loaded.Installations.Should().HaveCount(1);
        loaded.Installations[0].Id.Should().Be("test-1");
        loaded.Installations[0].Name.Should().Be("Test Install");
    }

    [Fact]
    public async Task GetConfig_NormalizesValues()
    {
        var json = """
        {
            "schemaVersion": 2,
            "window": { "width": 500, "height": 200, "x": 0, "y": 0, "maximized": false },
            "installations": [
                { "id": "", "name": "Bad", "path": "/foo" },
                { "id": "good", "name": "Good", "path": "/bar", "backupsLimit": 999 }
            ],
            "gameVersions": [],
            "favMods": [],
            "customIcons": []
        }
        """;
        await File.WriteAllTextAsync(_configPath, json);

        var config = await _service.GetConfigAsync();
        config.Window.Width.Should().Be(1024);
        config.Window.Height.Should().Be(600);
        config.Installations.Should().HaveCount(1);
        config.Installations[0].Id.Should().Be("good");
        config.Installations[0].BackupsLimit.Should().Be(100);
    }

    [Fact]
    public async Task GetConfig_MigratesFloatEra()
    {
        var json = """{"version": 1.6, "installations": [], "gameVersions": [], "favMods": [], "customIcons": []}""";
        await File.WriteAllTextAsync(_configPath, json);

        var config = await _service.GetConfigAsync();
        config.SchemaVersion.Should().Be(ConfigMigrations.CurrentSchema);

        var rawJson = await File.ReadAllTextAsync(_configPath);
        using var doc = JsonDocument.Parse(rawJson);
        doc.RootElement.GetProperty("schemaVersion").GetInt32().Should().Be(2);
    }
}
