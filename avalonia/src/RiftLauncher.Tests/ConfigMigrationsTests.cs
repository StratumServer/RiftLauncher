using System.Text.Json.Nodes;
using RiftLauncher.Core.Domain.Config;

namespace RiftLauncher.Tests;

public class ConfigMigrationsTests
{
    [Fact]
    public void DetectSchema_NullDoc_ReturnsUnreadable()
    {
        var result = ConfigMigrations.DetectSchema(null);
        result.Era.Should().Be(ConfigSchemaEra.Unreadable);
        result.Schema.Should().BeNull();
    }

    [Fact]
    public void DetectSchema_ArrayDoc_ReturnsUnreadable()
    {
        var node = JsonNode.Parse("[1,2,3]");
        var result = ConfigMigrations.DetectSchema(node);
        result.Era.Should().Be(ConfigSchemaEra.Unreadable);
        result.Schema.Should().BeNull();
    }

    [Fact]
    public void DetectSchema_IntegerSchemaVersion_ReturnsInteger()
    {
        var node = JsonNode.Parse("""{"schemaVersion": 2}""");
        var result = ConfigMigrations.DetectSchema(node);
        result.Era.Should().Be(ConfigSchemaEra.Integer);
        result.Schema.Should().Be(2);
    }

    [Fact]
    public void DetectSchema_FloatVersion_ReturnsFloat()
    {
        var node = JsonNode.Parse("""{"version": 1.6}""");
        var result = ConfigMigrations.DetectSchema(node);
        result.Era.Should().Be(ConfigSchemaEra.Float);
        result.Schema.Should().Be(ConfigMigrations.FloatEraSchema);
    }

    [Fact]
    public void DetectSchema_NoMarker_ReturnsAbsent()
    {
        var node = JsonNode.Parse("""{"installations": []}""");
        var result = ConfigMigrations.DetectSchema(node);
        result.Era.Should().Be(ConfigSchemaEra.Absent);
        result.Schema.Should().Be(ConfigMigrations.FloatEraSchema);
    }

    [Fact]
    public void MigrateDocument_AlreadyCurrent_NoChanges()
    {
        var node = JsonNode.Parse("""{"schemaVersion": 2, "installations": []}""");
        var result = ConfigMigrations.MigrateDocument(node);
        result.Outcome.Should().Be(ConfigMigrationOutcome.AlreadyCurrent);
        result.Schema.Should().Be(2);
        result.Applied.Should().BeEmpty();
    }

    [Fact]
    public void MigrateDocument_FloatEra_MigratesToCurrent()
    {
        var node = JsonNode.Parse("""{"version": 1.6, "installations": []}""");
        var result = ConfigMigrations.MigrateDocument(node);
        result.Outcome.Should().Be(ConfigMigrationOutcome.Migrated);
        result.Schema.Should().Be(ConfigMigrations.CurrentSchema);
        result.Applied.Should().HaveCount(1);
        result.Applied[0].FromSchema.Should().Be(1);
        result.Applied[0].ToSchema.Should().Be(2);

        var doc = result.Doc as JsonObject;
        doc.Should().NotBeNull();
        doc!.ContainsKey("version").Should().BeFalse();
        doc["schemaVersion"]!.GetValue<int>().Should().Be(2);
    }

    [Fact]
    public void MigrateDocument_FutureSchema_PassesThrough()
    {
        var node = JsonNode.Parse("""{"schemaVersion": 50}""");
        var result = ConfigMigrations.MigrateDocument(node);
        result.Outcome.Should().Be(ConfigMigrationOutcome.FutureSchema);
        result.Schema.Should().Be(50);
        result.Applied.Should().BeEmpty();
    }

    [Fact]
    public void MigrateDocument_UnreadableDoc_ReturnsUnreadable()
    {
        var result = ConfigMigrations.MigrateDocument(null);
        result.Outcome.Should().Be(ConfigMigrationOutcome.Unreadable);
        result.Schema.Should().BeNull();
    }

    [Theory]
    [InlineData(null, 2)]
    [InlineData(2, 2)]
    [InlineData(50, 50)]
    [InlineData(1, 2)]
    [InlineData(100, 2)]
    public void ClampSchema_ClampsCorrectly(int? input, int expected)
    {
        ConfigMigrations.ClampSchema(input).Should().Be(expected);
    }
}
