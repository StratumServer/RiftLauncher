using System.Collections.ObjectModel;
using System.Globalization;
using Avalonia.Data.Converters;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RiftLauncher.Core.Domain.Config;
using RiftLauncher.Core.Services;

namespace RiftLauncher.ViewModels.Pages;

public partial class InstallationsListViewModel : ViewModelBase
{
    public static readonly IValueConverter InitialConverter =
        new FuncValueConverter<string, string>(name =>
            string.IsNullOrEmpty(name) ? "?" : name[..1].ToUpperInvariant());

    private readonly IConfigService _configService;
    private readonly ITaskManagerService _taskManager;

    [ObservableProperty]
    private ObservableCollection<InstallationItemViewModel> _installations = new();

    [ObservableProperty]
    private InstallationItemViewModel? _installationToDelete;

    [ObservableProperty]
    private bool _deleteDataChecked;

    [ObservableProperty]
    private bool _isDeleteDialogOpen;

    public InstallationsListViewModel() { _configService = null!; _taskManager = null!; }

    public InstallationsListViewModel(IConfigService configService, ITaskManagerService taskManager)
    {
        _configService = configService;
        _taskManager = taskManager;
    }

    [RelayCommand]
    private async Task LoadAsync()
    {
        var config = await _configService.GetConfigAsync();
        Installations.Clear();

        foreach (var inst in config.Installations)
        {
            var isVersionMissing = !config.GameVersions.Exists(gv => gv.Version == inst.Version);
            Installations.Add(new InstallationItemViewModel
            {
                Id = inst.Id,
                Name = inst.Name,
                Icon = inst.Icon,
                Version = inst.Version,
                Path = inst.Path,
                IsVersionMissing = isVersionMissing,
                ModsCount = inst.ModsCount,
                LastTimePlayed = inst.LastTimePlayed,
                TotalTimePlayed = inst.TotalTimePlayed,
                BackupsCount = inst.Backups.Count
            });
        }
    }

    [RelayCommand]
    private void RequestDelete(InstallationItemViewModel installation)
    {
        InstallationToDelete = installation;
        DeleteDataChecked = false;
        IsDeleteDialogOpen = true;
    }

    [RelayCommand]
    private async Task ConfirmDeleteAsync()
    {
        if (InstallationToDelete == null) return;

        var config = await _configService.GetConfigAsync();
        var installation = config.Installations.Find(i => i.Id == InstallationToDelete.Id);
        if (installation == null) return;

        if (DeleteDataChecked && Directory.Exists(installation.Path))
        {
            try { Directory.Delete(installation.Path, recursive: true); }
            catch { /* log but continue */ }
        }

        config.Installations.RemoveAll(i => i.Id == installation.Id);
        await _configService.SaveConfigAsync(config);

        Installations.Remove(InstallationToDelete);
        IsDeleteDialogOpen = false;
        InstallationToDelete = null;
    }

    [RelayCommand]
    private void CancelDelete()
    {
        IsDeleteDialogOpen = false;
        InstallationToDelete = null;
    }

    [RelayCommand]
    private async Task MakeBackupAsync(string installationId)
    {
        var config = await _configService.GetConfigAsync();
        var installation = config.Installations.Find(i => i.Id == installationId);
        if (installation == null) return;
        if (!Directory.Exists(installation.Path)) return;
        if (installation.BackupsLimit <= 0) return;

        var backupsDir = System.IO.Path.Combine(installation.Path, "..", "backups", installation.Id);
        Directory.CreateDirectory(backupsDir);

        var timestamp = DateTime.UtcNow.ToString("yyyy-MM-dd_HH-mm-ss");
        var archiveName = $"backup_{timestamp}.zip";

        await _taskManager.StartCompressAsync(
            installation.Name,
            "Creating backup",
            installation.Path,
            backupsDir,
            archiveName);

        var backup = new Backup
        {
            Id = Guid.NewGuid().ToString("N"),
            Date = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Path = System.IO.Path.Combine(backupsDir, archiveName)
        };
        installation.Backups.Insert(0, backup);

        while (installation.Backups.Count > installation.BackupsLimit)
        {
            var oldest = installation.Backups[^1];
            if (File.Exists(oldest.Path))
                File.Delete(oldest.Path);
            installation.Backups.RemoveAt(installation.Backups.Count - 1);
        }

        await _configService.SaveConfigAsync(config);
    }

    [RelayCommand]
    private void OpenFolder(string path)
    {
        if (!Directory.Exists(path)) return;
        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
        {
            FileName = path,
            UseShellExecute = true
        });
    }
}

public partial class InstallationItemViewModel : ObservableObject
{
    [ObservableProperty] private string _id = string.Empty;
    [ObservableProperty] private string _name = string.Empty;
    [ObservableProperty] private string _icon = string.Empty;
    [ObservableProperty] private string _version = string.Empty;
    [ObservableProperty] private string _path = string.Empty;
    [ObservableProperty] private bool _isVersionMissing;
    [ObservableProperty] private int _modsCount;
    [ObservableProperty] private long _lastTimePlayed;
    [ObservableProperty] private long _totalTimePlayed;
    [ObservableProperty] private int _backupsCount;

    public string LastPlayedDisplay => LastTimePlayed <= 0
        ? "Not played yet"
        : DateTimeOffset.FromUnixTimeMilliseconds(LastTimePlayed).LocalDateTime.ToString("g");

    public string TotalTimeDisplay
    {
        get
        {
            var span = TimeSpan.FromMilliseconds(TotalTimePlayed);
            return span.TotalHours >= 1
                ? $"{(int)span.TotalHours}h {span.Minutes}m"
                : $"{span.Minutes}m";
        }
    }
}
