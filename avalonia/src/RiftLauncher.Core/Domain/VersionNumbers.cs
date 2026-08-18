namespace RiftLauncher.Core.Domain;

public static class VersionNumbers
{
    public static int Compare(string a, string b)
    {
        var left = Parse(a);
        var right = Parse(b);
        var max = Math.Max(left.Length, right.Length);

        for (var i = 0; i < max; i++)
        {
            var l = i < left.Length ? left[i] : 0;
            var r = i < right.Length ? right[i] : 0;
            var diff = l - r;
            if (diff != 0) return diff;
        }

        return 0;
    }

    private static int[] Parse(string version)
    {
        var dashIndex = version.IndexOf('-');
        var numeric = dashIndex >= 0 ? version[..dashIndex] : version;
        var parts = numeric.Split('.');
        var result = new int[parts.Length];

        for (var i = 0; i < parts.Length; i++)
            int.TryParse(parts[i], out result[i]);

        return result;
    }
}
