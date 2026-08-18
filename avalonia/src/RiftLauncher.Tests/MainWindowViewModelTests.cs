using FluentAssertions;
using NSubstitute;
using RiftLauncher.Core.Services;
using RiftLauncher.ViewModels;
using RiftLauncher.ViewModels.Pages;

namespace RiftLauncher.Tests;

public class MainWindowViewModelTests
{
    private static MainWindowViewModel CreateVm()
    {
        var taskManager = Substitute.For<ITaskManagerService>();
        taskManager.Tasks.Returns(new System.Collections.ObjectModel.ObservableCollection<TaskItem>());
        var tasksVm = new TasksViewModel(taskManager);
        return new MainWindowViewModel(tasksVm);
    }

    [Fact]
    public void Constructor_SetsHomeAsInitialPage()
    {
        var vm = CreateVm();

        vm.CurrentPage.Should().BeOfType<HomeViewModel>();
        vm.WindowTitle.Should().Be("Rift Launcher");
        vm.SelectedNavIndex.Should().Be(0);
    }

    [Theory]
    [InlineData(0, typeof(HomeViewModel))]
    [InlineData(1, typeof(InstallationsListViewModel))]
    [InlineData(2, typeof(VersionsListViewModel))]
    [InlineData(3, typeof(ModsListViewModel))]
    [InlineData(4, typeof(ConfigViewModel))]
    [InlineData(5, typeof(InfoHelpViewModel))]
    public void SelectedNavIndex_NavigatesToCorrectPage(int index, Type expectedType)
    {
        var vm = CreateVm();

        vm.SelectedNavIndex = index;

        vm.CurrentPage.Should().BeOfType(expectedType);
    }

    [Fact]
    public void SelectedNavIndex_InvalidIndex_KeepsCurrentPage()
    {
        var vm = CreateVm();
        var initialPage = vm.CurrentPage;

        vm.SelectedNavIndex = 99;

        vm.CurrentPage.Should().BeSameAs(initialPage);
    }
}
