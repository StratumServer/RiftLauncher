using Microsoft.Extensions.Logging.Abstractions;
using RiftLauncher.Core.Services;

namespace RiftLauncher.Tests;

public class LocalizationServiceTests : IDisposable
{
    private readonly string _tempDir;
    private readonly JsonLocalizationService _service;

    public LocalizationServiceTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), $"rift-i18n-{Guid.NewGuid():N}");
        Directory.CreateDirectory(_tempDir);

        File.WriteAllText(Path.Combine(_tempDir, "en-US.json"), """
        {
            "generic": {
                "play": "Play",
                "delete": "Delete",
                "minMaxLength": "{{min}} to {{max}} characters"
            },
            "features": {
                "home": {
                    "title": "Welcome"
                }
            }
        }
        """);

        File.WriteAllText(Path.Combine(_tempDir, "pt-BR.json"), """
        {
            "generic": {
                "play": "Jogar",
                "delete": "Excluir",
                "minMaxLength": "{{min}} a {{max}} caracteres"
            },
            "features": {
                "home": {
                    "title": "Bem-vindo"
                }
            }
        }
        """);

        _service = new JsonLocalizationService(NullLogger<JsonLocalizationService>.Instance, _tempDir);
    }

    public void Dispose()
    {
        if (Directory.Exists(_tempDir))
            Directory.Delete(_tempDir, recursive: true);
    }

    [Fact]
    public async Task InitializeAsync_LoadsEnglish()
    {
        await _service.InitializeAsync();
        _service.CurrentLanguage.Should().Be("en-US");
        _service["generic.play"].Should().Be("Play");
    }

    [Fact]
    public async Task Translate_FlattenedKeys_Work()
    {
        await _service.InitializeAsync();
        _service["features.home.title"].Should().Be("Welcome");
    }

    [Fact]
    public async Task Translate_Interpolation_ReplacesParams()
    {
        await _service.InitializeAsync();
        var result = _service.Translate("generic.minMaxLength", new Dictionary<string, object>
        {
            ["min"] = 3,
            ["max"] = 50
        });
        result.Should().Be("3 to 50 characters");
    }

    [Fact]
    public async Task Translate_MissingKey_ReturnsKey()
    {
        await _service.InitializeAsync();
        _service["nonexistent.key"].Should().Be("nonexistent.key");
    }

    [Fact]
    public async Task ChangeLanguage_SwitchesToPortuguese()
    {
        await _service.InitializeAsync();
        var changed = await _service.ChangeLanguageAsync("pt-BR");
        changed.Should().BeTrue();
        _service.CurrentLanguage.Should().Be("pt-BR");
        _service["generic.play"].Should().Be("Jogar");
    }

    [Fact]
    public async Task ChangeLanguage_InvalidCode_ReturnsFalse()
    {
        await _service.InitializeAsync();
        var changed = await _service.ChangeLanguageAsync("xx-XX");
        changed.Should().BeFalse();
        _service.CurrentLanguage.Should().Be("en-US");
    }

    [Fact]
    public async Task ChangeLanguage_FallsBackToEnglish_ForMissingKeys()
    {
        await _service.InitializeAsync();

        File.WriteAllText(Path.Combine(_tempDir, "es-ES.json"), """
        {
            "generic": {
                "play": "Jugar"
            }
        }
        """);

        await _service.ChangeLanguageAsync("es-ES");
        _service["generic.play"].Should().Be("Jugar");
        _service["generic.delete"].Should().Be("Delete");
    }

    [Fact]
    public void AvailableLanguages_Contains14Locales()
    {
        _service.AvailableLanguages.Should().HaveCount(14);
        _service.AvailableLanguages.Select(l => l.Code).Should().Contain("en-US");
        _service.AvailableLanguages.Select(l => l.Code).Should().Contain("pt-BR");
    }
}
