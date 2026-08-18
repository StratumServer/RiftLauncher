using System;
using System.IO;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;

namespace RiftLauncher.Views;

public partial class MainWindow : Window
{
    private static readonly string StateFile = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "RiftLauncher", "window-state.json");

    public MainWindow()
    {
        InitializeComponent();
        RestoreWindowState();
    }

    protected override void OnOpened(EventArgs e)
    {
        base.OnOpened(e);
    }

    protected override void OnClosing(WindowClosingEventArgs e)
    {
        SaveWindowState();
        base.OnClosing(e);
    }

    private void SaveWindowState()
    {
        try
        {
            var state = new WindowState_
            {
                X = Position.X,
                Y = Position.Y,
                Width = Width,
                Height = Height,
                IsMaximized = WindowState == WindowState.Maximized
            };

            var dir = Path.GetDirectoryName(StateFile)!;
            Directory.CreateDirectory(dir);
            var json = JsonSerializer.Serialize(state);
            File.WriteAllText(StateFile, json);
        }
        catch
        {
            // Non-critical, ignore
        }
    }

    private void RestoreWindowState()
    {
        try
        {
            if (!File.Exists(StateFile)) return;

            var json = File.ReadAllText(StateFile);
            var state = JsonSerializer.Deserialize<WindowState_>(json);
            if (state is null) return;

            if (state.IsMaximized)
            {
                WindowState = WindowState.Maximized;
            }
            else
            {
                Width = state.Width;
                Height = state.Height;
                if (state.X >= 0 && state.Y >= 0)
                    Position = new PixelPoint(state.X, state.Y);
            }
        }
        catch
        {
            // Non-critical, ignore
        }
    }

    private sealed class WindowState_
    {
        public int X { get; set; }
        public int Y { get; set; }
        public double Width { get; set; } = 1280;
        public double Height { get; set; } = 720;
        public bool IsMaximized { get; set; }
    }
}
