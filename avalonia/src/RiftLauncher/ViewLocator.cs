using System;
using System.Diagnostics.CodeAnalysis;
using System.Reflection;
using Avalonia.Controls;
using Avalonia.Controls.Templates;
using RiftLauncher.ViewModels;

namespace RiftLauncher;

[RequiresUnreferencedCode("ViewLocator uses reflection for convention-based view resolution.")]
public class ViewLocator : IDataTemplate
{
    private static readonly Assembly ViewAssembly = typeof(ViewLocator).Assembly;

    public Control? Build(object? param)
    {
        if (param is null)
            return null;

        var vmName = param.GetType().FullName!;
        var viewName = vmName.Replace("ViewModels", "Views", StringComparison.Ordinal)
                             .Replace("ViewModel", "View", StringComparison.Ordinal);

        var type = ViewAssembly.GetType(viewName);
        Console.WriteLine($"[ViewLocator] VM={vmName} -> View={viewName} -> Type={type?.Name ?? "NOT FOUND"}");

        if (type != null)
            return (Control)Activator.CreateInstance(type)!;

        return new TextBlock { Text = "View not found: " + viewName };
    }

    public bool Match(object? data)
    {
        return data is ViewModelBase;
    }
}
