using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RiftLauncher.Core.Domain.Config;
using RiftLauncher.Core.Services;

namespace RiftLauncher.ViewModels.Pages;

public partial class InstallationFormViewModel : ViewModelBase
{
    private readonly IConfigService _configService;
    private readonly bool _isEdit;
    private string? _editId;

    [ObservableProperty] private string _name = string.Empty;
    [ObservableProperty] private string _icon = string.Empty;
    [ObservableProperty] private string _version = string.Empty;
    [ObservableProperty] private string _path = string.Empty;
    [ObservableProperty] private string _startParams = string.Empty;
    [ObservableProperty] private int _backupsLimit = 3;
    [ObservableProperty] private bool _backupsAuto;
    [ObservableProperty] private int _compressionLevel = 6;
    [ObservableProperty] private bool _mesaGlThread;
    [ObservableProperty] private string _envVars = string.Empty;

    [ObservableProperty] private bool _isPathEditable = true;
    [ObservableProperty] private bool _pathSetByUser;
    [ObservableProperty] private string? _missingVersionWarning;
    [ObservableProperty] private string? _errorMessage;
    [ObservableProperty] private bool _isBusy;

    [ObservableProperty]
    private ObservableCollection<GameVersionOption> _availableVersions = new();

    [ObservableProperty]
    private GameVersionOption? _selectedVersion;

    [ObservableProperty]
    private ObservableCollection<IconOption> _availableIcons = new();

    [ObservableProperty]
    private IconOption? _selectedIcon;

    public bool IsEdit => _isEdit;
    public string PageTitle => _isEdit ? "Edit Installation" : "Add Installation";

    public InstallationFormViewModel() { _configService = null!; }

    public InstallationFormViewModel(IConfigService configService, bool isEdit = false, string? editId = null)
    {
        _configService = configService;
        _isEdit = isEdit;
        _editId = editId;
        IsPathEditable = !isEdit;
    }

    [RelayCommand]
    private async Task LoadAsync()
    {
        var config = await _configService.GetConfigAsync();

        AvailableVersions.Clear();
        foreach (var gv in config.GameVersions.OrderByDescending(v => v.Version))
        {
            AvailableVersions.Add(new GameVersionOption { Version = gv.Version, Path = gv.Path });
        }

        AvailableIcons.Clear();
        foreach (var icon in InstallationIcons.BuiltIn)
        {
            AvailableIcons.Add(new IconOption { Id = icon.Id, Name = icon.Name, IsCustom = false });
        }
        foreach (var ci in config.CustomIcons)
        {
            AvailableIcons.Add(new IconOption { Id = ci.Id, Name = ci.Name, IsCustom = true });
        }

        if (_isEdit && _editId != null)
        {
            var installation = config.Installations.Find(i => i.Id == _editId);
            if (installation == null)
            {
                ErrorMessage = "Installation not found";
                return;
            }

            Name = installation.Name;
            Icon = installation.Icon;
            Version = installation.Version;
            Path = installation.Path;
            StartParams = installation.StartParams;
            BackupsLimit = installation.BackupsLimit;
            BackupsAuto = installation.BackupsAuto;
            CompressionLevel = installation.CompressionLevel;
            MesaGlThread = installation.MesaGlThread;
            EnvVars = installation.EnvVars;

            SelectedVersion = AvailableVersions.FirstOrDefault(v => v.Version == installation.Version);
            SelectedIcon = AvailableIcons.FirstOrDefault(i => i.Id == installation.Icon);

            if (SelectedVersion == null)
            {
                MissingVersionWarning = string.IsNullOrEmpty(installation.Version)
                    ? "Pick a version"
                    : $"Version {installation.Version} is not installed. Pick another.";
            }
        }
        else
        {
            SelectedVersion = AvailableVersions.FirstOrDefault();
            SelectedIcon = AvailableIcons.FirstOrDefault();
            Name = "New Installation";
            BackupsLimit = 3;
            CompressionLevel = 6;

            if (SelectedVersion != null)
                Version = SelectedVersion.Version;
            if (SelectedIcon != null)
                Icon = SelectedIcon.Id;

            UpdateAutoPath(config);
        }
    }

    partial void OnNameChanged(string value)
    {
        if (!_isEdit && !PathSetByUser)
            _ = UpdateAutoPathFromNameAsync();
    }

    partial void OnSelectedVersionChanged(GameVersionOption? value)
    {
        if (value != null)
        {
            Version = value.Version;
            MissingVersionWarning = null;
        }
    }

    partial void OnSelectedIconChanged(IconOption? value)
    {
        if (value != null)
            Icon = value.Id;
    }

    private async Task UpdateAutoPathFromNameAsync()
    {
        var config = await _configService.GetConfigAsync();
        UpdateAutoPath(config);
    }

    private void UpdateAutoPath(AppConfig config)
    {
        if (string.IsNullOrWhiteSpace(Name)) return;
        var baseDir = config.Settings?.DefaultInstallationsFolder
            ?? System.IO.Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "RiftLauncher", "installations");
        var cleanName = Core.Domain.Naming.CleanFolderName(Name);
        Path = System.IO.Path.Combine(baseDir, cleanName);
    }

    [RelayCommand]
    private async Task PickFolderAsync()
    {
        // In real usage, this would call StorageProvider.OpenFolderPickerAsync
        // For now, this is a placeholder that will be wired to the view
        PathSetByUser = true;
    }

    [RelayCommand]
    private async Task SaveAsync()
    {
        ErrorMessage = null;

        if (string.IsNullOrWhiteSpace(Name) || Name.Length < 5 || Name.Length > 50)
        {
            ErrorMessage = "Name must be between 5 and 50 characters";
            return;
        }

        if (string.IsNullOrWhiteSpace(Version))
        {
            ErrorMessage = "Select a game version";
            return;
        }

        if (!_isEdit && string.IsNullOrWhiteSpace(Path))
        {
            ErrorMessage = "Select a data folder path";
            return;
        }

        IsBusy = true;
        try
        {
            var config = await _configService.GetConfigAsync();

            if (_isEdit && _editId != null)
            {
                var installation = config.Installations.Find(i => i.Id == _editId);
                if (installation == null)
                {
                    ErrorMessage = "Installation not found";
                    return;
                }

                installation.Name = Name;
                installation.Icon = Icon;
                installation.Version = Version;
                installation.StartParams = StartParams;
                installation.BackupsLimit = BackupsLimit;
                installation.BackupsAuto = BackupsAuto;
                installation.CompressionLevel = CompressionLevel;
                installation.MesaGlThread = MesaGlThread;
                installation.EnvVars = EnvVars;
            }
            else
            {
                if (!System.IO.Directory.Exists(Path))
                    System.IO.Directory.CreateDirectory(Path);

                var newInstallation = new Installation
                {
                    Id = Guid.NewGuid().ToString("N"),
                    Name = Name,
                    Icon = Icon,
                    Version = Version,
                    Path = Path,
                    StartParams = StartParams,
                    BackupsLimit = BackupsLimit,
                    BackupsAuto = BackupsAuto,
                    CompressionLevel = CompressionLevel,
                    MesaGlThread = MesaGlThread,
                    EnvVars = EnvVars,
                    LastTimePlayed = -1,
                    TotalTimePlayed = 0,
                    ModsCount = 0,
                    Backups = new()
                };
                config.Installations.Add(newInstallation);
            }

            await _configService.SaveConfigAsync(config);
            // Navigation back will be handled by the view
        }
        finally
        {
            IsBusy = false;
        }
    }
}

public class GameVersionOption
{
    public string Version { get; set; } = string.Empty;
    public string Path { get; set; } = string.Empty;
}

public class IconOption
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public bool IsCustom { get; set; }
}

public static class InstallationIcons
{
    public static readonly IReadOnlyList<IconOption> BuiltIn = new List<IconOption>
    {
        new() { Id = "default", Name = "Default" },
        new() { Id = "survival", Name = "Survival" },
        new() { Id = "creative", Name = "Creative" },
        new() { Id = "modded", Name = "Modded" },
        new() { Id = "testing", Name = "Testing" },
        new() { Id = "vanilla", Name = "Vanilla" }
    };
}
