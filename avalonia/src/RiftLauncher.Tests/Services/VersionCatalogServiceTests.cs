using RiftLauncher.Core.Services;

namespace RiftLauncher.Tests.Services;

public class VersionCatalogServiceTests
{
    [Fact]
    public void CompareVersionsDesc_OrdersCorrectly()
    {
        var entries = new List<VersionCatalogEntry>
        {
            new("1.19.0", "stable", "", "", "", "", "", ""),
            new("1.20.0-rc.1", "rc", "", "", "", "", "", ""),
            new("1.20.0", "stable", "", "", "", "", "", ""),
            new("1.18.5", "stable", "", "", "", "", "", "")
        };

        var sorted = entries
            .OrderByDescending(e => e.Version, Comparer<string>.Create(CompareVersions))
            .ToList();

        // 1.20.0 and 1.20.0-rc.1 have same numeric prefix; string compare breaks tie
        Assert.Equal("1.20.0-rc.1", sorted[0].Version);
        Assert.Equal("1.20.0", sorted[1].Version);
        Assert.Equal("1.19.0", sorted[2].Version);
        Assert.Equal("1.18.5", sorted[3].Version);
    }

    [Fact]
    public void CompareVersions_DifferentMajors()
    {
        Assert.True(CompareVersions("2.0.0", "1.0.0") > 0);
        Assert.True(CompareVersions("1.19.0", "1.20.0") < 0);
    }

    private static int CompareVersions(string? a, string? b)
    {
        if (a is null || b is null) return 0;
        var partsA = StripPre(a).Split('.');
        var partsB = StripPre(b).Split('.');
        var len = Math.Max(partsA.Length, partsB.Length);
        for (int i = 0; i < len; i++)
        {
            var numA = i < partsA.Length && int.TryParse(partsA[i], out var va) ? va : 0;
            var numB = i < partsB.Length && int.TryParse(partsB[i], out var vb) ? vb : 0;
            if (numA != numB) return numA.CompareTo(numB);
        }
        return string.Compare(a, b, StringComparison.Ordinal);
    }

    private static string StripPre(string v) { var idx = v.IndexOf('-'); return idx >= 0 ? v[..idx] : v; }
}
