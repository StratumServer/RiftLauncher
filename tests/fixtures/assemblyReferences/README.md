# AssemblyRef fixtures

`images.json` contains gzip-compressed managed PE fixtures written by Mono.Cecil 0.11.6, encoded as base64 so test runners need neither .NET nor Cecil. These are test inputs, never launcher payloads.

The checked-in generator creates an assembly with TypeRef, TypeDef, Field, MethodDef, Param, MemberRef, Constant and CustomAttribute rows before AssemblyRef, plus GenericParam and GenericParamConstraint rows after it. The string-only and blob-only fixtures independently exercise their 4-byte heap flags. The wide fixture has 16,384 additional referenced types, widening coded indices as well as both heaps.

To recreate the inputs, run `dotnet run --project Fixture.csproj --artifacts-path /path/to/artifacts -- /path/to/output` with .NET 10, gzip each emitted DLL with timestamp zero, and base64 encode it into the matching JSON key. Only the fixture data and generator source are tracked; build outputs stay outside the repository.
