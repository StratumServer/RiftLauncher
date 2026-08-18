using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RiftLauncher.Core.Services;

namespace RiftLauncher.ViewModels;

public partial class TasksViewModel : ViewModelBase
{
    private readonly ITaskManagerService _taskManager;

    [ObservableProperty]
    private bool _isOpen;

    public ObservableCollection<TaskItem> Tasks => _taskManager.Tasks;

    public bool HasActiveTasks => _taskManager.HasActiveTasks;

    public int ActiveTaskCount => Tasks.Count(t =>
        t.Status is TaskItemStatus.Pending or TaskItemStatus.InProgress);

    public TasksViewModel(ITaskManagerService taskManager)
    {
        _taskManager = taskManager;
        _taskManager.ActiveTasksChanged += (_, _) =>
        {
            OnPropertyChanged(nameof(HasActiveTasks));
            OnPropertyChanged(nameof(ActiveTaskCount));
        };

        Tasks.CollectionChanged += (_, _) =>
        {
            OnPropertyChanged(nameof(HasActiveTasks));
            OnPropertyChanged(nameof(ActiveTaskCount));
        };
    }

    [RelayCommand]
    private void Toggle() => IsOpen = !IsOpen;

    [RelayCommand]
    private void RemoveTask(string taskId) => _taskManager.RemoveTask(taskId);

    [RelayCommand]
    private void CancelTask(string taskId) => _taskManager.CancelTask(taskId);
}
