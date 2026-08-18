using System;
using System.Collections.ObjectModel;
using System.Threading;
using CommunityToolkit.Mvvm.ComponentModel;

namespace RiftLauncher.ViewModels;

public enum NotificationType
{
    Info,
    Success,
    Warning,
    Error
}

public class NotificationItem
{
    public string Id { get; } = Guid.NewGuid().ToString();
    public string Message { get; init; } = "";
    public NotificationType Type { get; init; }
    public DateTime CreatedAt { get; } = DateTime.UtcNow;
    public Action? OnClick { get; init; }
}

public partial class NotificationsViewModel : ViewModelBase
{
    public ObservableCollection<NotificationItem> Notifications { get; } = new();

    private readonly SynchronizationContext? _syncContext = SynchronizationContext.Current;

    public void AddNotification(string message, NotificationType type, Action? onClick = null)
    {
        var item = new NotificationItem { Message = message, Type = type, OnClick = onClick };

        void Add()
        {
            Notifications.Add(item);
            // Auto-dismiss after 5 seconds
            var timer = new Timer(_ =>
            {
                void Remove() => Notifications.Remove(item);
                if (_syncContext != null)
                    _syncContext.Post(_ => Remove(), null);
                else
                    Remove();
            }, null, 5000, Timeout.Infinite);
        }

        if (_syncContext != null)
            _syncContext.Post(_ => Add(), null);
        else
            Add();
    }

    public void RemoveNotification(NotificationItem item)
    {
        Notifications.Remove(item);
    }

    public void HandleNotificationClick(NotificationItem item)
    {
        item.OnClick?.Invoke();
        RemoveNotification(item);
    }
}
