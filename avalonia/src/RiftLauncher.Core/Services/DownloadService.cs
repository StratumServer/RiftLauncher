namespace RiftLauncher.Core.Services;

public interface IDownloadService
{
    Task<string> DownloadAsync(
        string url,
        string outputDirectory,
        string fileName,
        IProgress<double>? progress = null,
        CancellationToken cancellationToken = default);
}

public sealed class DownloadService : IDownloadService
{
    private readonly HttpClient _httpClient;

    public DownloadService(HttpClient httpClient)
    {
        _httpClient = httpClient;
    }

    public async Task<string> DownloadAsync(
        string url,
        string outputDirectory,
        string fileName,
        IProgress<double>? progress = null,
        CancellationToken cancellationToken = default)
    {
        Directory.CreateDirectory(outputDirectory);
        var filePath = Path.Combine(outputDirectory, fileName);

        using var response = await _httpClient.GetAsync(
            url, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();

        var totalBytes = response.Content.Headers.ContentLength;
        await using var contentStream = await response.Content.ReadAsStreamAsync(cancellationToken);
        await using var fileStream = new FileStream(
            filePath, FileMode.Create, FileAccess.Write, FileShare.None, 81920, true);

        var buffer = new byte[81920];
        long bytesRead = 0;
        int read;

        while ((read = await contentStream.ReadAsync(buffer, cancellationToken)) > 0)
        {
            await fileStream.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            bytesRead += read;

            if (totalBytes > 0)
            {
                var percent = (double)bytesRead / totalBytes.Value * 100;
                progress?.Report(percent);
            }
        }

        progress?.Report(100);
        return filePath;
    }
}
