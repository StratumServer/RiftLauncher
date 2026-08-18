using System.IO.Compression;
using Microsoft.Extensions.Logging;
using SharpCompress.Common;
using SharpCompress.Readers;

namespace RiftLauncher.Core.Services;

public interface IArchiveService
{
    Task ExtractAsync(
        string sourcePath,
        string outputDirectory,
        IProgress<double>? progress = null,
        CancellationToken cancellationToken = default);

    Task CompressAsync(
        string inputDirectory,
        string outputDirectory,
        string archiveName,
        IProgress<double>? progress = null,
        CancellationToken cancellationToken = default);
}

public sealed class ArchiveService : IArchiveService
{
    private readonly ILogger<ArchiveService> _logger;

    public ArchiveService(ILogger<ArchiveService> logger)
    {
        _logger = logger;
    }

    public async Task ExtractAsync(
        string sourcePath,
        string outputDirectory,
        IProgress<double>? progress = null,
        CancellationToken cancellationToken = default)
    {
        if (!File.Exists(sourcePath))
            throw new FileNotFoundException("Archive not found", sourcePath);

        Directory.CreateDirectory(outputDirectory);

        var extension = Path.GetExtension(sourcePath).ToLowerInvariant();

        if (extension == ".zip")
        {
            await ExtractZipAsync(sourcePath, outputDirectory, progress, cancellationToken);
        }
        else
        {
            await ExtractWithSharpCompressAsync(sourcePath, outputDirectory, progress, cancellationToken);
        }
    }

    private static async Task ExtractZipAsync(
        string sourcePath,
        string outputDirectory,
        IProgress<double>? progress,
        CancellationToken cancellationToken)
    {
        await Task.Run(() =>
        {
            using var archive = ZipFile.OpenRead(sourcePath);
            var totalEntries = archive.Entries.Count;
            var processed = 0;

            foreach (var entry in archive.Entries)
            {
                cancellationToken.ThrowIfCancellationRequested();

                var destinationPath = Path.Combine(outputDirectory, entry.FullName);

                if (string.IsNullOrEmpty(entry.Name))
                {
                    Directory.CreateDirectory(destinationPath);
                }
                else
                {
                    var dir = Path.GetDirectoryName(destinationPath);
                    if (dir != null) Directory.CreateDirectory(dir);
                    entry.ExtractToFile(destinationPath, overwrite: true);
                }

                processed++;
                progress?.Report((double)processed / totalEntries * 100);
            }
        }, cancellationToken);
    }

    private async Task ExtractWithSharpCompressAsync(
        string sourcePath,
        string outputDirectory,
        IProgress<double>? progress,
        CancellationToken cancellationToken)
    {
        await using var reader = await ReaderFactory.OpenAsyncReader(sourcePath, new ReaderOptions());
        var processed = 0;

        while (await reader.MoveToNextEntryAsync(cancellationToken))
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (!reader.Entry.IsDirectory)
            {
                await reader.WriteEntryToDirectoryAsync(outputDirectory, new ExtractionOptions
                {
                    ExtractFullPath = true,
                    Overwrite = true
                });
            }

            processed++;
            progress?.Report(processed);
        }

        progress?.Report(100);

        _logger.LogDebug("Extracted {Source} to {Output}", sourcePath, outputDirectory);
    }

    public async Task CompressAsync(
        string inputDirectory,
        string outputDirectory,
        string archiveName,
        IProgress<double>? progress = null,
        CancellationToken cancellationToken = default)
    {
        if (!Directory.Exists(inputDirectory))
            throw new DirectoryNotFoundException($"Input directory not found: {inputDirectory}");

        Directory.CreateDirectory(outputDirectory);
        var outputPath = Path.Combine(outputDirectory, archiveName);

        await Task.Run(() =>
        {
            var files = Directory.GetFiles(inputDirectory, "*", SearchOption.AllDirectories);
            var totalFiles = files.Length;

            using var archive = ZipFile.Open(outputPath, ZipArchiveMode.Create);
            for (var i = 0; i < files.Length; i++)
            {
                cancellationToken.ThrowIfCancellationRequested();

                var relativePath = Path.GetRelativePath(inputDirectory, files[i]);
                archive.CreateEntryFromFile(files[i], relativePath, CompressionLevel.Optimal);

                progress?.Report((double)(i + 1) / totalFiles * 100);
            }
        }, cancellationToken);

        _logger.LogDebug("Compressed {Input} to {Output}", inputDirectory, outputPath);
    }
}
