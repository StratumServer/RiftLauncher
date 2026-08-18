namespace RiftLauncher.Core.Domain;

public static class Naming
{
    public static string CleanFolderName(string folderName)
    {
        var result = System.Text.RegularExpressions.Regex.Replace(folderName, @"[<>:""/\\|?*]", "-");
        result = System.Text.RegularExpressions.Regex.Replace(result, @"\s+", "-");
        result = System.Text.RegularExpressions.Regex.Replace(result, @"-+", "-");
        result = result.Trim('-');
        return result;
    }

    public static string FormatTimestampForFilename(long epochMillis)
    {
        var date = DateTimeOffset.FromUnixTimeMilliseconds(epochMillis).UtcDateTime;
        return date.ToString("yyyy-MM-dd_HH-mm-ss");
    }
}
