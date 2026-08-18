using System.Text.Json;
using System.Text.Json.Nodes;

namespace RiftLauncher.Core.Domain.Config;

public enum ConfigSchemaEra
{
    Integer,
    Float,
    Absent,
    Unreadable
}

public enum ConfigMigrationOutcome
{
    AlreadyCurrent,
    Migrated,
    FutureSchema,
    ChainBroken,
    MigrationFailed,
    Unreadable
}

public sealed record DetectedConfigSchema(ConfigSchemaEra Era, int? Schema);

public sealed record AppliedMigration(int FromSchema, int ToSchema);

public sealed record ConfigMigrationResult(
    JsonNode? Doc,
    DetectedConfigSchema Detected,
    int? Schema,
    IReadOnlyList<AppliedMigration> Applied,
    ConfigMigrationOutcome Outcome);

public interface IConfigMigration
{
    int FromSchema { get; }
    int ToSchema { get; }
    JsonNode? Migrate(JsonNode? doc);
}

public static class ConfigMigrations
{
    public const int CurrentSchema = 2;
    public const int FirstIntegerSchema = 2;
    public const int FloatEraSchema = 1;
    public const int MaxSchema = 99;

    private static readonly IReadOnlyList<IConfigMigration> Migrations =
    [
        new FloatMarkerToIntegerSchema()
    ];

    public static DetectedConfigSchema DetectSchema(JsonNode? doc)
    {
        if (doc is not JsonObject obj)
            return new DetectedConfigSchema(ConfigSchemaEra.Unreadable, null);

        if (obj.TryGetPropertyValue("schemaVersion", out var schemaNode) &&
            schemaNode is JsonValue schemaValue &&
            schemaValue.TryGetValue<int>(out var marker) &&
            marker >= FirstIntegerSchema && marker <= MaxSchema)
        {
            return new DetectedConfigSchema(ConfigSchemaEra.Integer, marker);
        }

        if (obj.TryGetPropertyValue("version", out var versionNode) &&
            versionNode is JsonValue versionValue &&
            versionValue.TryGetValue<double>(out var floatVersion) &&
            double.IsFinite(floatVersion))
        {
            return new DetectedConfigSchema(ConfigSchemaEra.Float, FloatEraSchema);
        }

        return new DetectedConfigSchema(ConfigSchemaEra.Absent, FloatEraSchema);
    }

    public static int ClampSchema(int? value)
    {
        if (value is null) return CurrentSchema;
        return value.Value >= FirstIntegerSchema && value.Value <= MaxSchema
            ? value.Value
            : CurrentSchema;
    }

    public static ConfigMigrationResult MigrateDocument(
        JsonNode? doc,
        IReadOnlyList<IConfigMigration>? migrations = null,
        int? targetSchema = null)
    {
        migrations ??= Migrations;
        var target = targetSchema ?? CurrentSchema;

        var detected = DetectSchema(doc);
        if (detected.Schema is null)
            return new ConfigMigrationResult(doc, detected, null, [], ConfigMigrationOutcome.Unreadable);
        if (detected.Schema > target)
            return new ConfigMigrationResult(doc, detected, detected.Schema, [], ConfigMigrationOutcome.FutureSchema);
        if (detected.Schema == target)
            return new ConfigMigrationResult(doc, detected, detected.Schema, [], ConfigMigrationOutcome.AlreadyCurrent);

        var available = migrations.ToDictionary(m => m.FromSchema);
        var applied = new List<AppliedMigration>();
        var current = doc;
        var schema = detected.Schema.Value;

        while (schema < target)
        {
            if (!available.TryGetValue(schema, out var migration) || migration.ToSchema <= schema)
                return new ConfigMigrationResult(current, detected, schema, applied, ConfigMigrationOutcome.ChainBroken);

            JsonNode? stepped;
            try
            {
                stepped = migration.Migrate(current);
            }
            catch
            {
                return new ConfigMigrationResult(current, detected, schema, applied, ConfigMigrationOutcome.MigrationFailed);
            }

            if (stepped is not JsonObject steppedObj)
                return new ConfigMigrationResult(current, detected, schema, applied, ConfigMigrationOutcome.MigrationFailed);

            steppedObj["schemaVersion"] = migration.ToSchema;
            current = steppedObj;
            schema = migration.ToSchema;
            applied.Add(new AppliedMigration(migration.FromSchema, migration.ToSchema));
        }

        return new ConfigMigrationResult(current, detected, schema, applied, ConfigMigrationOutcome.Migrated);
    }
}

internal sealed class FloatMarkerToIntegerSchema : IConfigMigration
{
    public int FromSchema => ConfigMigrations.FloatEraSchema;
    public int ToSchema => ConfigMigrations.FirstIntegerSchema;

    public JsonNode? Migrate(JsonNode? doc)
    {
        if (doc is not JsonObject obj) return doc;

        var cloned = obj.Deserialize<JsonObject>();
        cloned?.Remove("version");
        return cloned;
    }
}
