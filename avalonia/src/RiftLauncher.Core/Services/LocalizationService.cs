using System.ComponentModel;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;

namespace RiftLauncher.Core.Services;

public sealed class LanguageInfo
{
    public required string Code { get; init; }
    public required string Name { get; init; }
    public required string Credits { get; init; }
}

public interface ILocalizationService : INotifyPropertyChanged
{
    string CurrentLanguage { get; }
    IReadOnlyList<LanguageInfo> AvailableLanguages { get; }
    Task<bool> ChangeLanguageAsync(string languageCode);
    string Translate(string key, IDictionary<string, object>? parameters = null);
    string this[string key] { get; }
}

public sealed partial class JsonLocalizationService : ILocalizationService
{
    private static readonly Regex InterpolationPattern = InterpolationRegex();

    private readonly ILogger<JsonLocalizationService> _logger;
    private readonly string _localesDirectory;
    private readonly Dictionary<string, Dictionary<string, string>> _translations = new();
    private Dictionary<string, string> _currentTranslations = new();
    private Dictionary<string, string> _fallbackTranslations = new();

    public string CurrentLanguage { get; private set; } = "en-US";

    public IReadOnlyList<LanguageInfo> AvailableLanguages { get; } =
    [
        new() { Code = "en-US", Name = "English", Credits = "by XurxoMF" },
        new() { Code = "es-ES", Name = "Español (España)", Credits = "by XurxoMF" },
        new() { Code = "ru-RU", Name = "Русский", Credits = "by megabezdelnik" },
        new() { Code = "zh-CN", Name = "简体中文", Credits = "by liuyujielol" },
        new() { Code = "fr-FR", Name = "Français", Credits = "by LorIlcs" },
        new() { Code = "de-DE", Name = "Deutsch", Credits = "by Brady_The" },
        new() { Code = "pt-PT", Name = "Português", Credits = "by Bruno Cabrita" },
        new() { Code = "pt-BR", Name = "Português (Brasil)", Credits = "by Paulo Nascimento, Zaldaryon" },
        new() { Code = "nl-NL", Name = "Dutch (Netherlands)", Credits = "by Dennisjeee" },
        new() { Code = "pl-PL", Name = "Polski", Credits = "by Runo Hawk, Zsuatem" },
        new() { Code = "it-IT", Name = "Italiano", Credits = "by Pingoda" },
        new() { Code = "hu-HU", Name = "Magyar", Credits = "by dobisan" },
        new() { Code = "uk-UA", Name = "Українська", Credits = "by rXelelo" },
        new() { Code = "be-BY", Name = "Беларуская", Credits = "" }
    ];

    public event PropertyChangedEventHandler? PropertyChanged;

    public JsonLocalizationService(ILogger<JsonLocalizationService> logger, string localesDirectory)
    {
        _logger = logger;
        _localesDirectory = localesDirectory;
    }

    public async Task InitializeAsync()
    {
        await LoadLanguageFileAsync("en-US");
        _fallbackTranslations = _translations.GetValueOrDefault("en-US") ?? new();
        _currentTranslations = _fallbackTranslations;
    }

    public async Task<bool> ChangeLanguageAsync(string languageCode)
    {
        if (languageCode == CurrentLanguage) return true;
        if (AvailableLanguages.All(l => l.Code != languageCode)) return false;

        if (!_translations.ContainsKey(languageCode))
        {
            if (!await LoadLanguageFileAsync(languageCode))
                return false;
        }

        CurrentLanguage = languageCode;
        _currentTranslations = _translations.GetValueOrDefault(languageCode) ?? _fallbackTranslations;
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(CurrentLanguage)));
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs("Item[]"));
        return true;
    }

    public string Translate(string key, IDictionary<string, object>? parameters = null)
    {
        var value = _currentTranslations.GetValueOrDefault(key)
                    ?? _fallbackTranslations.GetValueOrDefault(key)
                    ?? key;

        if (parameters is null || parameters.Count == 0)
            return value;

        return InterpolationPattern.Replace(value, match =>
        {
            var paramName = match.Groups[1].Value;
            return parameters.TryGetValue(paramName, out var paramValue)
                ? Convert.ToString(paramValue, CultureInfo.InvariantCulture) ?? string.Empty
                : match.Value;
        });
    }

    public string this[string key] => Translate(key);

    private async Task<bool> LoadLanguageFileAsync(string languageCode)
    {
        var path = Path.Combine(_localesDirectory, $"{languageCode}.json");
        if (!File.Exists(path))
        {
            _logger.LogWarning("Locale file not found: {Path}", path);
            return false;
        }

        try
        {
            var json = await File.ReadAllTextAsync(path);
            using var doc = JsonDocument.Parse(json);
            var flatMap = new Dictionary<string, string>();
            FlattenJson(doc.RootElement, "", flatMap);
            _translations[languageCode] = flatMap;
            _logger.LogInformation("Loaded {Count} translation keys for {Language}", flatMap.Count, languageCode);
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to load locale file: {Path}", path);
            return false;
        }
    }

    private static void FlattenJson(JsonElement element, string prefix, Dictionary<string, string> result)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                foreach (var property in element.EnumerateObject())
                {
                    var key = string.IsNullOrEmpty(prefix) ? property.Name : $"{prefix}.{property.Name}";
                    FlattenJson(property.Value, key, result);
                }
                break;
            case JsonValueKind.String:
                result[prefix] = element.GetString() ?? string.Empty;
                break;
            case JsonValueKind.Number:
                result[prefix] = element.GetRawText();
                break;
            case JsonValueKind.True:
                result[prefix] = "true";
                break;
            case JsonValueKind.False:
                result[prefix] = "false";
                break;
        }
    }

    [GeneratedRegex(@"\{\{(\w+)\}\}")]
    private static partial Regex InterpolationRegex();
}
