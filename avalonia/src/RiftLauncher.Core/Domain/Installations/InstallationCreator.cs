namespace RiftLauncher.Core.Domain.Installations;

public static class InstallationConstants
{
    public const int NameMinLength = 5;
    public const int NameMaxLength = 50;
    public const string ReservedStartParam = "--dataPath";
    public const string BackupSubfolder = "Installations";
}

public enum InstallationFieldsFailure
{
    NameLength,
    ReservedStartParam
}

public enum CreateInstallationFailure
{
    NameLength,
    ReservedStartParam,
    FolderInUse
}

public sealed record CreatedInstallation(
    string Id,
    string Name,
    string Icon,
    string Path,
    string Version,
    string StartParams,
    int BackupsLimit,
    bool BackupsAuto,
    int CompressionLevel,
    bool MesaGlThread,
    string EnvVars);

public sealed record CreateInstallationInput(
    string Name,
    string Icon,
    string Path,
    string Version,
    string StartParams,
    int BackupsLimit,
    bool BackupsAuto,
    int CompressionLevel,
    bool MesaGlThread,
    string EnvVars,
    IReadOnlyList<string> FoldersInUse);

public sealed record CreateInstallationResult(bool Ok, CreatedInstallation? Installation = null, CreateInstallationFailure? Reason = null)
{
    public static CreateInstallationResult Success(CreatedInstallation installation) => new(true, installation);
    public static CreateInstallationResult Failure(CreateInstallationFailure reason) => new(false, Reason: reason);
}

public static class InstallationCreator
{
    public static CreateInstallationResult Create(CreateInstallationInput input)
    {
        var fieldsResult = ValidateFields(input.Name, input.StartParams);
        if (fieldsResult is not null)
            return CreateInstallationResult.Failure(fieldsResult.Value);

        if (input.FoldersInUse.Contains(input.Path))
            return CreateInstallationResult.Failure(CreateInstallationFailure.FolderInUse);

        var installation = new CreatedInstallation(
            Id: Guid.NewGuid().ToString(),
            Name: input.Name,
            Icon: input.Icon,
            Path: input.Path,
            Version: input.Version,
            StartParams: input.StartParams,
            BackupsLimit: input.BackupsLimit,
            BackupsAuto: input.BackupsAuto,
            CompressionLevel: input.CompressionLevel,
            MesaGlThread: input.MesaGlThread,
            EnvVars: input.EnvVars);

        return CreateInstallationResult.Success(installation);
    }

    public static CreateInstallationFailure? ValidateFields(string name, string startParams)
    {
        if (name.Length < InstallationConstants.NameMinLength || name.Length > InstallationConstants.NameMaxLength)
            return CreateInstallationFailure.NameLength;
        if (startParams.Contains(InstallationConstants.ReservedStartParam, StringComparison.Ordinal))
            return CreateInstallationFailure.ReservedStartParam;
        return null;
    }
}
