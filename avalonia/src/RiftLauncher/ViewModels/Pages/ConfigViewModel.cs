using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RiftLauncher.Core.Domain.Config;
using RiftLauncher.Core.Services;

namespace RiftLauncher.ViewModels.Pages;

public partial class ConfigViewModel : ViewModelBase
{
    private readonly IConfigService _configService;
    private readonly ILocalizationService _localizationService;

    [ObservableProperty]
    private string _language = "en-US";

    [ObservableProperty]
    private int _uiScale = 100;

    [ObservableProperty]
    private bool _minimizeToTray;

    [ObservableProperty]
    private bool _closeToTray;

    [ObservableProperty]
    private string _defaultInstallationsFolder = "";

    [ObservableProperty]
    private string _defaultVersionsFolder = "";

    [ObservableProperty]
    private string _backupsFolder = "";

    public IReadOnlyList<string> AvailableLanguages { get; } =
        ["en-US", "pt-BR", "pt-PT", "es-ES", "fr-FR", "de-DE", "ru-RU", "uk-UA", "be-BY", "pl-PL", "hu-HU", "it-IT", "nl-NL", "zh-CN"];

    public IReadOnlyList<int> AvailableScales { get; } = [50, 75, 100, 125, 150];

    public ConfigViewModel(IConfigService configService, ILocalizationService localizationService)
    {
        _configService = configService;
        _localizationService = localizationService;
        _ = LoadAsync();
    }

    public ConfigViewModel() : this(null!, null!)
    {
    }

    private async Task LoadAsync()
    {
        if (_configService is null) return;
        var config = await _configService.GetConfigAsync();
        Language = config.Settings?.Language ?? "en-US";
        UiScale = config.Settings?.UiScale ?? 100;
        MinimizeToTray = config.Settings?.MinimizeToTray ?? false;
        CloseToTray = config.Settings?.CloseToTray ?? false;
        DefaultInstallationsFolder = config.DefaultInstallationsFolder;
        DefaultVersionsFolder = config.DefaultVersionsFolder;
        BackupsFolder = config.BackupsFolder;
    }

    [RelayCommand]
    private async Task SaveAsync()
    {
        if (_configService is null) return;
        var config = await _configService.GetConfigAsync();
        config.Settings ??= new AppSettings();
        config.Settings.Language = Language;
        config.Settings.UiScale = UiScale;
        config.Settings.MinimizeToTray = MinimizeToTray;
        config.Settings.CloseToTray = CloseToTray;
        config.DefaultInstallationsFolder = DefaultInstallationsFolder;
        config.DefaultVersionsFolder = DefaultVersionsFolder;
        config.BackupsFolder = BackupsFolder;
        await _configService.SaveConfigAsync(config);

        _localizationService?.ChangeLanguageAsync(Language);
    }

    partial void OnLanguageChanged(string value) => _ = SaveAsync();
    partial void OnUiScaleChanged(int value) => _ = SaveAsync();
    partial void OnMinimizeToTrayChanged(bool value) => _ = SaveAsync();
    partial void OnCloseToTrayChanged(bool value) => _ = SaveAsync();
}
