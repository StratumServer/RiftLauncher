using System;
using System.IO;
using Mono.Cecil;
using Mono.Cecil.Cil;

foreach (int mode in new[] {0, 1, 2, 3}) {
  bool wide = mode == 3;
  using var assembly = AssemblyDefinition.CreateAssembly(new AssemblyNameDefinition("ReaderFixture", new Version(1,0)), "ReaderFixture.dll", ModuleKind.Dll);
  var module = assembly.MainModule;
  var dependency = new AssemblyNameReference("Optimum.GameContent", new Version(1,0));
  module.AssemblyReferences.Add(dependency);
  var type = new TypeDefinition("Fixture", "Example", TypeAttributes.Public | TypeAttributes.Class, module.TypeSystem.Object);
  module.Types.Add(type);
  var generic = new GenericParameter("T", type);
  generic.Constraints.Add(new GenericParameterConstraint(module.TypeSystem.Object));
  type.GenericParameters.Add(generic);
  var field = new FieldDefinition("Value", FieldAttributes.Public | FieldAttributes.Literal | FieldAttributes.Static | FieldAttributes.HasDefault, module.TypeSystem.Int32) { Constant = 7 };
  type.Fields.Add(field);
  if (mode == 1) field.Name = new string('s', 70000);
  var ctorRef = module.ImportReference(typeof(ObsoleteAttribute).GetConstructor(new[] {typeof(string)}));
  var attribute = new CustomAttribute(ctorRef);
  attribute.ConstructorArguments.Add(new CustomAttributeArgument(module.TypeSystem.String, mode == 2 || wide ? new string('b', 70000) : "fixture"));
  type.CustomAttributes.Add(attribute);
  var method = new MethodDefinition("Read", MethodAttributes.Public | MethodAttributes.Static, module.TypeSystem.Int32);
  method.Parameters.Add(new ParameterDefinition("argument", ParameterAttributes.None, module.TypeSystem.Int32));
  method.Body.Instructions.Add(Instruction.Create(OpCodes.Ldc_I4_7));
  method.Body.Instructions.Add(Instruction.Create(OpCodes.Ret));
  type.Methods.Add(method);
  type.Fields.Add(new FieldDefinition("Dependency", FieldAttributes.Public, new TypeReference("Optimum", "NeededType", module, dependency)));
  if (wide) {
    for(int i = 0; i < 16384; i++) type.Fields.Add(new FieldDefinition("F" + i, FieldAttributes.Public, new TypeReference("Optimum", "Type" + i, module, dependency)));
  }
  assembly.Write(Path.Combine(args[0], new[] {"standard.dll", "strings.dll", "blob.dll", "wide.dll"}[mode]));
}
