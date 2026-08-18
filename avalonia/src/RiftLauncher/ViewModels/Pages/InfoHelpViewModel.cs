using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace RiftLauncher.ViewModels.Pages;

public partial class InfoHelpViewModel : ViewModelBase
{
    [ObservableProperty]
    private string _appVersion = "";

    [ObservableProperty]
    private string _dotNetVersion = "";

    public InfoHelpViewModel()
    {
        AppVersion = System.Reflection.Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "dev";
        DotNetVersion = System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription;
    }

    [RelayCommand]
    private void OpenGitHub()
    {
        OpenUrl("https://github.com/StratumServer/RiftLauncher");
    }

    [RelayCommand]
    private void OpenDiscord()
    {
        OpenUrl("https://discord.gg/stratum");
    }

    [RelayCommand]
    private void OpenVintageStory()
    {
        OpenUrl("https://www.vintagestory.at");
    }

    private static void OpenUrl(string url)
    {
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = url,
                UseShellExecute = true
            });
        }
        catch { }
    }
}
