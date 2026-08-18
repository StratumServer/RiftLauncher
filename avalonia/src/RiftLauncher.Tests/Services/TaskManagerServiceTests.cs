using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using RiftLauncher.Core.Services;

namespace RiftLauncher.Tests.Services;

public class TaskManagerServiceTests
{
    private readonly IDownloadService _downloadService = Substitute.For<IDownloadService>();
    private readonly IArchiveService _archiveService = Substitute.For<IArchiveService>();
    private readonly TaskManagerService _sut;

    public TaskManagerServiceTests()
    {
        _sut = new TaskManagerService(
            NullLogger<TaskManagerService>.Instance,
            _downloadService,
            _archiveService);
    }

    [Fact]
    public void StartTask_AddsTaskToCollection()
    {
        var task = _sut.StartTask("Test", "Description", TaskItemType.Download);

        _sut.Tasks.Should().ContainSingle();
        _sut.Tasks[0].Should().BeSameAs(task);
        task.Name.Should().Be("Test");
        task.Description.Should().Be("Description");
        task.Type.Should().Be(TaskItemType.Download);
        task.Status.Should().Be(TaskItemStatus.InProgress);
        task.Progress.Should().Be(0);
    }

    [Fact]
    public void StartTask_InsertsAtBeginning()
    {
        var first = _sut.StartTask("First", "", TaskItemType.Download);
        var second = _sut.StartTask("Second", "", TaskItemType.Extract);

        _sut.Tasks[0].Should().BeSameAs(second);
        _sut.Tasks[1].Should().BeSameAs(first);
    }

    [Fact]
    public void UpdateProgress_ClampsValue()
    {
        var task = _sut.StartTask("Test", "", TaskItemType.Download);

        _sut.UpdateProgress(task.Id, 150);
        task.Progress.Should().Be(100);

        _sut.UpdateProgress(task.Id, -5);
        task.Progress.Should().Be(0);
    }

    [Fact]
    public void UpdateProgress_IgnoresCompletedTask()
    {
        var task = _sut.StartTask("Test", "", TaskItemType.Download);
        _sut.CompleteTask(task.Id);

        _sut.UpdateProgress(task.Id, 50);
        task.Progress.Should().Be(100);
    }

    [Fact]
    public void CompleteTask_SetsStatusAndProgress()
    {
        var task = _sut.StartTask("Test", "", TaskItemType.Download);
        _sut.UpdateProgress(task.Id, 80);

        _sut.CompleteTask(task.Id);

        task.Status.Should().Be(TaskItemStatus.Completed);
        task.Progress.Should().Be(100);
    }

    [Fact]
    public void CompleteTask_IsIdempotent()
    {
        var task = _sut.StartTask("Test", "", TaskItemType.Download);
        var completedCount = 0;
        _sut.TaskCompleted += (_, _) => completedCount++;

        _sut.CompleteTask(task.Id);
        _sut.CompleteTask(task.Id);

        completedCount.Should().Be(1);
    }

    [Fact]
    public void FailTask_SetsStatusAndError()
    {
        var task = _sut.StartTask("Test", "", TaskItemType.Download);

        _sut.FailTask(task.Id, "Something went wrong");

        task.Status.Should().Be(TaskItemStatus.Failed);
        task.ErrorMessage.Should().Be("Something went wrong");
    }

    [Fact]
    public void RemoveTask_RemovesFromCollection()
    {
        var task = _sut.StartTask("Test", "", TaskItemType.Download);
        _sut.CompleteTask(task.Id);

        _sut.RemoveTask(task.Id);

        _sut.Tasks.Should().BeEmpty();
    }

    [Fact]
    public void CancelTask_CancelsAndFails()
    {
        var task = _sut.StartTask("Test", "", TaskItemType.Download);

        _sut.CancelTask(task.Id);

        task.Status.Should().Be(TaskItemStatus.Failed);
        task.ErrorMessage.Should().Be("Cancelled by user");
        task.Cancellation.IsCancellationRequested.Should().BeTrue();
    }

    [Fact]
    public void CancelTask_IgnoresTerminalTasks()
    {
        var task = _sut.StartTask("Test", "", TaskItemType.Download);
        _sut.CompleteTask(task.Id);

        _sut.CancelTask(task.Id);

        task.Status.Should().Be(TaskItemStatus.Completed);
        task.Cancellation.IsCancellationRequested.Should().BeFalse();
    }

    [Fact]
    public void HasActiveTasks_ReflectsState()
    {
        _sut.HasActiveTasks.Should().BeFalse();

        var task = _sut.StartTask("Test", "", TaskItemType.Download);
        _sut.HasActiveTasks.Should().BeTrue();

        _sut.CompleteTask(task.Id);
        _sut.HasActiveTasks.Should().BeFalse();
    }

    [Fact]
    public void ActiveTasksChanged_FiresOnStateTransitions()
    {
        var fireCount = 0;
        _sut.ActiveTasksChanged += (_, _) => fireCount++;

        var task = _sut.StartTask("Test", "", TaskItemType.Download);
        fireCount.Should().Be(1);

        _sut.CompleteTask(task.Id);
        fireCount.Should().Be(2);

        _sut.RemoveTask(task.Id);
        fireCount.Should().Be(3);
    }

    [Fact]
    public async Task StartDownloadAsync_CompletesSuccessfully()
    {
        var expectedPath = "/tmp/file.zip";
        _downloadService.DownloadAsync(
            Arg.Any<string>(), Arg.Any<string>(), Arg.Any<string>(),
            Arg.Any<IProgress<double>?>(), Arg.Any<CancellationToken>())
            .Returns(expectedPath);

        var result = await _sut.StartDownloadAsync(
            "Download", "Downloading file", "http://example.com/file.zip", "/tmp", "file.zip");

        result.Should().Be(expectedPath);
        _sut.Tasks[0].Status.Should().Be(TaskItemStatus.Completed);
    }

    [Fact]
    public async Task StartDownloadAsync_PropagatesProgress()
    {
        double reportedValue = -1;
        var capturedProgress = new Progress<double>(v => reportedValue = v);

        _downloadService.DownloadAsync(
            Arg.Any<string>(), Arg.Any<string>(), Arg.Any<string>(),
            Arg.Do<IProgress<double>?>(p => p?.Report(50)),
            Arg.Any<CancellationToken>())
            .Returns("/tmp/file.zip");

        await _sut.StartDownloadAsync(
            "Download", "desc", "http://example.com/file.zip", "/tmp", "file.zip",
            capturedProgress);

        await Task.Delay(50);
        reportedValue.Should().Be(50);
    }

    [Fact]
    public async Task StartDownloadAsync_HandlesFailure()
    {
        _downloadService.DownloadAsync(
            Arg.Any<string>(), Arg.Any<string>(), Arg.Any<string>(),
            Arg.Any<IProgress<double>?>(), Arg.Any<CancellationToken>())
            .Returns<string>(x => throw new HttpRequestException("Network error"));

        Func<Task> act = () => _sut.StartDownloadAsync(
            "Download", "desc", "http://example.com/file.zip", "/tmp", "file.zip");

        await act.Should().ThrowAsync<HttpRequestException>();
        _sut.Tasks[0].Status.Should().Be(TaskItemStatus.Failed);
        _sut.Tasks[0].ErrorMessage.Should().Be("Network error");
    }

    [Fact]
    public async Task StartExtractAsync_DeletesArchiveOnSuccess()
    {
        var tempFile = Path.GetTempFileName();
        try
        {
            await _sut.StartExtractAsync(
                "Extract", "desc", tempFile, "/tmp/out", deleteArchive: true);

            File.Exists(tempFile).Should().BeFalse();
            _sut.Tasks[0].Status.Should().Be(TaskItemStatus.Completed);
        }
        finally
        {
            if (File.Exists(tempFile)) File.Delete(tempFile);
        }
    }

    [Fact]
    public async Task StartCompressAsync_CompletesSuccessfully()
    {
        await _sut.StartCompressAsync(
            "Compress", "desc", "/tmp/input", "/tmp/output", "backup.zip");

        _sut.Tasks[0].Status.Should().Be(TaskItemStatus.Completed);
        await _archiveService.Received(1).CompressAsync(
            "/tmp/input", "/tmp/output", "backup.zip",
            Arg.Any<IProgress<double>?>(), Arg.Any<CancellationToken>());
    }
}
