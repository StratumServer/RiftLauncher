using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
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
        var configService = Substitute.For<IConfigService>();
        configService.GetConfigAsync().Returns(Task.FromResult(new RiftLauncher.Core.Domain.Config.AppConfig()));
        var accountService = Substitute.For<IAccountService>();

        var services = new ServiceCollection();
        services.AddSingleton(taskManager);
        services.AddSingleton(configService);
        services.AddSingleton(accountService);
        services.AddSingleton(Substitute.For<ILocalizationService>());
        services.AddSingleton(Substitute.For<IModDbService>());
        services.AddSingleton(Substitute.For<IDownloadService>());
        services.AddSingleton(Substitute.For<IVersionCatalogService>());
        services.AddSingleton(Substitute.For<IArchiveService>());
        services.AddTransient<HomeViewModel>();
        services.AddTransient<InstallationsListViewModel>();
        services.AddTransient<VersionsListViewModel>();
        services.AddTransient<ModsListViewModel>();
        services.AddTransient<ConfigViewModel>();
        services.AddTransient<InfoHelpViewModel>();
        var sp = services.BuildServiceProvider();

        var tasksVm = new TasksViewModel(taskManager);
        var loginVm = new LoginViewModel(accountService);
        var sessionVm = new SessionViewModel(accountService, loginVm);
        return new MainWindowViewModel(sp, tasksVm, sessionVm, configService, accountService);
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
