using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RiftLauncher.Core.Domain.Config;
using RiftLauncher.Core.Services;

namespace RiftLauncher.ViewModels.Pages;

public partial class BackupsViewModel : ViewModelBase
{
    private readonly IConfigService _configService;
    private readonly ITaskManagerService _taskManager;
    private string _installationId = string.Empty;

    [ObservableProperty]
    private string _installationName = string.Empty;

    [ObservableProperty]
    private ObservableCollection<BackupItemViewModel> _backups = new();

    [ObservableProperty]
    private BackupItemViewModel? _backupToRestore;

    [ObservableProperty]
    private BackupItemViewModel? _backupToDelete;

    [ObservableProperty]
    private bool _isRestoreDialogOpen;

    [ObservableProperty]
    private bool _isDeleteDialogOpen;

    public BackupsViewModel() { _configService = null!; _taskManager = null!; }

    public BackupsViewModel(IConfigService configService, ITaskManagerService taskManager, string installationId)
    {
        _configService = configService;
        _taskManager = taskManager;
        _installationId = installationId;
    }

    [RelayCommand]
    private async Task LoadAsync()
    {
        var config = await _configService.GetConfigAsync();
        var installation = config.Installations.Find(i => i.Id == _installationId);
        if (installation == null) return;

        InstallationName = installation.Name;
        Backups.Clear();

        foreach (var backup in installation.Backups.OrderByDescending(b => b.Date))
        {
            Backups.Add(new BackupItemViewModel
            {
                Id = backup.Id,
                Date = DateTimeOffset.FromUnixTimeMilliseconds(backup.Date).LocalDateTime,
                Path = backup.Path
            });
        }
    }

    [RelayCommand]
    private void RequestRestore(BackupItemViewModel backup)
    {
        BackupToRestore = backup;
        IsRestoreDialogOpen = true;
    }

    [RelayCommand]
    private async Task ConfirmRestoreAsync()
    {
        if (BackupToRestore == null) return;

        var config = await _configService.GetConfigAsync();
        var installation = config.Installations.Find(i => i.Id == _installationId);
        if (installation == null) return;

        if (!File.Exists(BackupToRestore.Path)) return;

        await _taskManager.StartExtractAsync(
            installation.Name,
            "Restoring backup",
            BackupToRestore.Path,
            installation.Path,
            deleteArchive: false);

        IsRestoreDialogOpen = false;
        BackupToRestore = null;
    }

    [RelayCommand]
    private void CancelRestore()
    {
        IsRestoreDialogOpen = false;
        BackupToRestore = null;
    }

    [RelayCommand]
    private void RequestDelete(BackupItemViewModel backup)
    {
        BackupToDelete = backup;
        IsDeleteDialogOpen = true;
    }

    [RelayCommand]
    private async Task ConfirmDeleteAsync()
    {
        if (BackupToDelete == null) return;

        if (File.Exists(BackupToDelete.Path))
            File.Delete(BackupToDelete.Path);

        var config = await _configService.GetConfigAsync();
        var installation = config.Installations.Find(i => i.Id == _installationId);
        if (installation != null)
        {
            installation.Backups.RemoveAll(b => b.Id == BackupToDelete.Id);
            await _configService.SaveConfigAsync(config);
        }

        Backups.Remove(BackupToDelete);
        IsDeleteDialogOpen = false;
        BackupToDelete = null;
    }

    [RelayCommand]
    private void CancelDelete()
    {
        IsDeleteDialogOpen = false;
        BackupToDelete = null;
    }

    [RelayCommand]
    private void OpenInExplorer(string path)
    {
        var dir = System.IO.Path.GetDirectoryName(path);
        if (dir == null || !Directory.Exists(dir)) return;
        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
        {
            FileName = dir,
            UseShellExecute = true
        });
    }
}

public partial class BackupItemViewModel : ObservableObject
{
    [ObservableProperty] private string _id = string.Empty;
    [ObservableProperty] private DateTime _date;
    [ObservableProperty] private string _path = string.Empty;

    public string DateDisplay => Date.ToString("g");
}
