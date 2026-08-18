using System.Collections.ObjectModel;
using System.Collections.Concurrent;
using CommunityToolkit.Mvvm.ComponentModel;
using Microsoft.Extensions.Logging;

namespace RiftLauncher.Core.Services;

public enum TaskItemType
{
    Download,
    Extract,
    Compress,
    Install
}

public enum TaskItemStatus
{
    Pending,
    InProgress,
    Completed,
    Failed
}

public partial class TaskItem : ObservableObject
{
    public string Id { get; } = Guid.NewGuid().ToString("N");

    [ObservableProperty]
    private string _name = string.Empty;

    [ObservableProperty]
    private string _description = string.Empty;

    [ObservableProperty]
    private TaskItemType _type;

    [ObservableProperty]
    private double _progress;

    [ObservableProperty]
    private TaskItemStatus _status = TaskItemStatus.Pending;

    [ObservableProperty]
    private string? _errorMessage;

    public CancellationTokenSource Cancellation { get; } = new();

    public DateTime StartedAt { get; } = DateTime.UtcNow;
}

public interface ITaskManagerService
{
    ObservableCollection<TaskItem> Tasks { get; }
    bool HasActiveTasks { get; }

    TaskItem StartTask(string name, string description, TaskItemType type);
    void UpdateProgress(string taskId, double progress);
    void CompleteTask(string taskId);
    void FailTask(string taskId, string? errorMessage = null);
    void RemoveTask(string taskId);
    void CancelTask(string taskId);

    Task<string> StartDownloadAsync(
        string name,
        string description,
        string url,
        string outputPath,
        string fileName,
        IProgress<double>? externalProgress = null,
        CancellationToken cancellationToken = default);

    Task StartExtractAsync(
        string name,
        string description,
        string sourcePath,
        string outputPath,
        bool deleteArchive = false,
        IProgress<double>? externalProgress = null,
        CancellationToken cancellationToken = default);

    Task StartCompressAsync(
        string name,
        string description,
        string inputPath,
        string outputPath,
        string archiveName,
        IProgress<double>? externalProgress = null,
        CancellationToken cancellationToken = default);

    event EventHandler<TaskItem>? TaskCompleted;
    event EventHandler<TaskItem>? TaskFailed;
    event EventHandler? ActiveTasksChanged;
}

public sealed class TaskManagerService : ObservableObject, ITaskManagerService
{
    private readonly ILogger<TaskManagerService> _logger;
    private readonly IDownloadService _downloadService;
    private readonly IArchiveService _archiveService;
    private readonly ConcurrentDictionary<string, TaskItem> _taskLookup = new();

    public ObservableCollection<TaskItem> Tasks { get; } = new();

    public bool HasActiveTasks => Tasks.Any(t =>
        t.Status is TaskItemStatus.Pending or TaskItemStatus.InProgress);

    public event EventHandler<TaskItem>? TaskCompleted;
    public event EventHandler<TaskItem>? TaskFailed;
    public event EventHandler? ActiveTasksChanged;

    public TaskManagerService(
        ILogger<TaskManagerService> logger,
        IDownloadService downloadService,
        IArchiveService archiveService)
    {
        _logger = logger;
        _downloadService = downloadService;
        _archiveService = archiveService;
    }

    public TaskItem StartTask(string name, string description, TaskItemType type)
    {
        var task = new TaskItem
        {
            Name = name,
            Description = description,
            Type = type,
            Status = TaskItemStatus.InProgress
        };

        _taskLookup[task.Id] = task;
        Tasks.Insert(0, task);
        ActiveTasksChanged?.Invoke(this, EventArgs.Empty);

        _logger.LogInformation("Task started: {Name} ({Type}) [{Id}]", name, type, task.Id);
        return task;
    }

    public void UpdateProgress(string taskId, double progress)
    {
        if (!_taskLookup.TryGetValue(taskId, out var task)) return;
        if (task.Status != TaskItemStatus.InProgress) return;

        var clamped = Math.Clamp(progress, 0, 100);
        if (Math.Abs(task.Progress - clamped) < 0.01) return;

        task.Progress = clamped;
    }

    public void CompleteTask(string taskId)
    {
        if (!_taskLookup.TryGetValue(taskId, out var task)) return;
        if (task.Status == TaskItemStatus.Completed) return;

        task.Progress = 100;
        task.Status = TaskItemStatus.Completed;
        ActiveTasksChanged?.Invoke(this, EventArgs.Empty);
        TaskCompleted?.Invoke(this, task);

        _logger.LogInformation("Task completed: {Name} [{Id}]", task.Name, taskId);
    }

    public void FailTask(string taskId, string? errorMessage = null)
    {
        if (!_taskLookup.TryGetValue(taskId, out var task)) return;
        if (task.Status is TaskItemStatus.Completed or TaskItemStatus.Failed) return;

        task.Status = TaskItemStatus.Failed;
        task.ErrorMessage = errorMessage;
        ActiveTasksChanged?.Invoke(this, EventArgs.Empty);
        TaskFailed?.Invoke(this, task);

        _logger.LogWarning("Task failed: {Name} [{Id}] - {Error}", task.Name, taskId, errorMessage);
    }

    public void RemoveTask(string taskId)
    {
        if (!_taskLookup.TryRemove(taskId, out var task)) return;
        Tasks.Remove(task);
        ActiveTasksChanged?.Invoke(this, EventArgs.Empty);
    }

    public void CancelTask(string taskId)
    {
        if (!_taskLookup.TryGetValue(taskId, out var task)) return;
        if (task.Status is not (TaskItemStatus.Pending or TaskItemStatus.InProgress)) return;

        task.Cancellation.Cancel();
        FailTask(taskId, "Cancelled by user");
    }

    public async Task<string> StartDownloadAsync(
        string name,
        string description,
        string url,
        string outputPath,
        string fileName,
        IProgress<double>? externalProgress = null,
        CancellationToken cancellationToken = default)
    {
        var task = StartTask(name, description, TaskItemType.Download);
        var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(
            cancellationToken, task.Cancellation.Token);

        try
        {
            var progress = new Progress<double>(p =>
            {
                UpdateProgress(task.Id, p);
                externalProgress?.Report(p);
            });

            var filePath = await _downloadService.DownloadAsync(
                url, outputPath, fileName, progress, linkedCts.Token);

            CompleteTask(task.Id);
            return filePath;
        }
        catch (OperationCanceledException)
        {
            FailTask(task.Id, "Cancelled");
            throw;
        }
        catch (Exception ex)
        {
            FailTask(task.Id, ex.Message);
            throw;
        }
        finally
        {
            linkedCts.Dispose();
        }
    }

    public async Task StartExtractAsync(
        string name,
        string description,
        string sourcePath,
        string outputPath,
        bool deleteArchive = false,
        IProgress<double>? externalProgress = null,
        CancellationToken cancellationToken = default)
    {
        var task = StartTask(name, description, TaskItemType.Extract);
        var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(
            cancellationToken, task.Cancellation.Token);

        try
        {
            var progress = new Progress<double>(p =>
            {
                UpdateProgress(task.Id, p);
                externalProgress?.Report(p);
            });

            await _archiveService.ExtractAsync(
                sourcePath, outputPath, progress, linkedCts.Token);

            if (deleteArchive && File.Exists(sourcePath))
                File.Delete(sourcePath);

            CompleteTask(task.Id);
        }
        catch (OperationCanceledException)
        {
            FailTask(task.Id, "Cancelled");
            throw;
        }
        catch (Exception ex)
        {
            FailTask(task.Id, ex.Message);
            throw;
        }
        finally
        {
            linkedCts.Dispose();
        }
    }

    public async Task StartCompressAsync(
        string name,
        string description,
        string inputPath,
        string outputPath,
        string archiveName,
        IProgress<double>? externalProgress = null,
        CancellationToken cancellationToken = default)
    {
        var task = StartTask(name, description, TaskItemType.Compress);
        var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(
            cancellationToken, task.Cancellation.Token);

        try
        {
            var progress = new Progress<double>(p =>
            {
                UpdateProgress(task.Id, p);
                externalProgress?.Report(p);
            });

            await _archiveService.CompressAsync(
                inputPath, outputPath, archiveName, progress, linkedCts.Token);

            CompleteTask(task.Id);
        }
        catch (OperationCanceledException)
        {
            FailTask(task.Id, "Cancelled");
            throw;
        }
        catch (Exception ex)
        {
            FailTask(task.Id, ex.Message);
            throw;
        }
        finally
        {
            linkedCts.Dispose();
        }
    }
}
