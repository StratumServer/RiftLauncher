using System.Globalization;
using Avalonia.Data.Converters;
using RiftLauncher.Core.Services;

namespace RiftLauncher.Views.Controls;

public static class TaskStatusConverters
{
    public static readonly IValueConverter IsActive =
        new FuncValueConverter<TaskItemStatus, bool>(s =>
            s is TaskItemStatus.Pending or TaskItemStatus.InProgress);

    public static readonly IValueConverter IsTerminal =
        new FuncValueConverter<TaskItemStatus, bool>(s =>
            s is TaskItemStatus.Completed or TaskItemStatus.Failed);

    public static readonly IValueConverter IsInProgress =
        new FuncValueConverter<TaskItemStatus, bool>(s =>
            s == TaskItemStatus.InProgress);

    public static readonly IValueConverter IsFailed =
        new FuncValueConverter<TaskItemStatus, bool>(s =>
            s == TaskItemStatus.Failed);

    public static readonly IMultiValueConverter ProgressWidth =
        new ProgressWidthConverter();

    private sealed class ProgressWidthConverter : IMultiValueConverter
    {
        public object? Convert(IList<object?> values, Type targetType, object? parameter, CultureInfo culture)
        {
            if (values.Count < 2) return 0.0;
            if (values[0] is not double progress) return 0.0;
            if (values[1] is not double totalWidth) return 0.0;

            return totalWidth * (progress / 100.0);
        }
    }
}
