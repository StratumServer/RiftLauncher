namespace RiftLauncher.Core.Domain.Config;

public sealed class AppConfig
{
    public int SchemaVersion { get; set; } = ConfigMigrations.CurrentSchema;
    public string? LastUsedInstallation { get; set; }
    public string DefaultInstallationsFolder { get; set; } = string.Empty;
    public string DefaultVersionsFolder { get; set; } = string.Empty;
    public string BackupsFolder { get; set; } = string.Empty;
    public WindowConfig Window { get; set; } = new();
    public AccountPublic? Account { get; set; }
    public List<Installation> Installations { get; set; } = [];
    public List<GameVersion> GameVersions { get; set; } = [];
    public List<int> FavMods { get; set; } = [];
    public List<CustomIcon> CustomIcons { get; set; } = [];
}

public sealed class WindowConfig
{
    public int Width { get; set; } = 1280;
    public int Height { get; set; } = 720;
    public int X { get; set; }
    public int Y { get; set; }
    public bool Maximized { get; set; }
}

public sealed class AccountPublic
{
    public string Email { get; set; } = string.Empty;
    public string PlayerName { get; set; } = string.Empty;
    public string PlayerUid { get; set; } = string.Empty;
    public string? PlayerEntitlements { get; set; }
    public bool HostGameServer { get; set; }
}

public sealed class Installation
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Icon { get; set; } = string.Empty;
    public string Path { get; set; } = string.Empty;
    public string Version { get; set; } = string.Empty;
    public string StartParams { get; set; } = string.Empty;
    public int BackupsLimit { get; set; } = 3;
    public bool BackupsAuto { get; set; }
    public int CompressionLevel { get; set; } = 4;
    public List<Backup> Backups { get; set; } = [];
    public long LastTimePlayed { get; set; } = -1;
    public long TotalTimePlayed { get; set; }
    public bool MesaGlThread { get; set; }
    public string EnvVars { get; set; } = string.Empty;
}

public sealed class Backup
{
    public string Id { get; set; } = string.Empty;
    public long Date { get; set; }
    public string Path { get; set; } = string.Empty;
}

public sealed class GameVersion
{
    public string Version { get; set; } = string.Empty;
    public string Path { get; set; } = string.Empty;
}

public sealed class CustomIcon
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Icon { get; set; } = string.Empty;
    public bool Custom { get; set; }
}
