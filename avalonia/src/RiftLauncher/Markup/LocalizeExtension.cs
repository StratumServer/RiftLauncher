using Avalonia.Data;
using Avalonia.Markup.Xaml;
using Avalonia.Markup.Xaml.MarkupExtensions;
using Microsoft.Extensions.DependencyInjection;

namespace RiftLauncher.Markup;

using Core.Services;

public class LocalizeExtension : MarkupExtension
{
    private readonly string _key;

    public LocalizeExtension(string key)
    {
        _key = key;
    }

    public override object ProvideValue(IServiceProvider serviceProvider)
    {
        var localization = App.Services.GetService<ILocalizationService>();
        return localization?[_key] ?? _key;
    }
}
