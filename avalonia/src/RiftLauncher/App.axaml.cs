using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using RiftLauncher.Core.Services;
using RiftLauncher.ViewModels;
using RiftLauncher.Views;

namespace RiftLauncher;

public partial class App : Application
{
    public static ServiceProvider Services { get; private set; } = null!;

    public override void Initialize()
    {
        AvaloniaXamlLoader.Load(this);
    }

    public override void OnFrameworkInitializationCompleted()
    {
        var services = new ServiceCollection();
        ConfigureServices(services);
        Services = services.BuildServiceProvider();

        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            desktop.MainWindow = new MainWindow
            {
                DataContext = Services.GetRequiredService<MainWindowViewModel>(),
            };
        }

        base.OnFrameworkInitializationCompleted();

        // Initialize localization after the window is shown (non-blocking)
        _ = InitializeLocalizationAsync();
    }

    private static async Task InitializeLocalizationAsync()
    {
        try
        {
            var localization = Services.GetRequiredService<ILocalizationService>();
            if (localization is JsonLocalizationService jsonLoc)
                await jsonLoc.InitializeAsync();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[App] Localization init failed: {ex.Message}");
        }
    }

    private static void ConfigureServices(IServiceCollection services)
    {
        services.AddLogging(builder => builder.AddDebug());

        var localesDir = GetLocalesDirectory();
        services.AddSingleton<ILocalizationService>(sp =>
            new JsonLocalizationService(
                sp.GetRequiredService<ILogger<JsonLocalizationService>>(),
                localesDir));

        services.AddSingleton<IConfigService>(sp =>
            new ConfigService(sp.GetRequiredService<ILogger<ConfigService>>()));

        services.AddSingleton<HttpClient>();
        services.AddSingleton<IDownloadService, DownloadService>();
        services.AddSingleton<IArchiveService, ArchiveService>();
        services.AddSingleton<ITaskManagerService, TaskManagerService>();
        services.AddSingleton<IVersionCatalogService, VersionCatalogService>();
        services.AddSingleton<IModDbService, ModDbService>();
        services.AddSingleton<IAccountService, AccountService>();
        services.AddSingleton<IUpdateService, UpdateService>();

        services.AddTransient<MainWindowViewModel>();
        services.AddTransient<TasksViewModel>();
        services.AddTransient<LoginViewModel>();
        services.AddTransient<SessionViewModel>();
    }

    private static string GetLocalesDirectory()
    {
        var baseDir = AppContext.BaseDirectory;
        var localesPath = Path.Combine(baseDir, "locales");
        if (Directory.Exists(localesPath))
            return localesPath;

        var devPath = Path.Combine(baseDir, "..", "..", "..", "..", "..", "locales");
        if (Directory.Exists(devPath))
            return Path.GetFullPath(devPath);

        return localesPath;
    }
}
