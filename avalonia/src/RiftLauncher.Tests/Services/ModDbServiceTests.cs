using RiftLauncher.Core.Services;

namespace RiftLauncher.Tests.Services;

public class ModDbServiceTests
{
    [Fact]
    public void ParseModList_ValidJson_ReturnsEntries()
    {
        var json = """
        {
            "statuscode": "200",
            "mods": [
                {
                    "modid": "test-mod",
                    "assetid": "12345",
                    "name": "Test Mod",
                    "summary": "A test mod",
                    "author": "TestAuthor",
                    "logo": "https://example.com/logo.png",
                    "downloads": 1000,
                    "follows": 50,
                    "comments": 10,
                    "side": "both",
                    "lastreleased": "2025-01-01",
                    "tags": ["utility", "qol"],
                    "gameversions": ["1.20.0", "1.19.8"]
                }
            ]
        }
        """;

        var entries = ParseViaReflection(json);
        Assert.Single(entries);
        Assert.Equal("test-mod", entries[0].ModId);
        Assert.Equal("12345", entries[0].AssetId);
        Assert.Equal("Test Mod", entries[0].Name);
        Assert.Equal(1000, entries[0].Downloads);
        Assert.Equal(2, entries[0].Tags.Count);
        Assert.Equal(2, entries[0].GameVersions.Count);
    }

    [Fact]
    public void ParseModList_BadStatus_ReturnsEmpty()
    {
        var json = """{"statuscode": "404", "mods": []}""";
        var entries = ParseViaReflection(json);
        Assert.Empty(entries);
    }

    [Fact]
    public void ParseModList_MalformedJson_Throws()
    {
        Assert.ThrowsAny<Exception>(() => ParseViaReflection("not json at all"));
    }

    private static IReadOnlyList<ModListEntry> ParseViaReflection(string json)
    {
        var method = typeof(ModDbService).GetMethod("ParseModList",
            System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic);
        return (IReadOnlyList<ModListEntry>)method!.Invoke(null, [json])!;
    }
}
