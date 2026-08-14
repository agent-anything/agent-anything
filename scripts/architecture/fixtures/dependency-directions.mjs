export const repositoryDirectionFixtures = [
  {
    name: "Harness to Harness",
    accepted: true,
    owner: pkg("harness", "agent-runtime"),
    imported: pkg("harness", "agent-core"),
  },
  {
    name: "Harness to Product",
    accepted: false,
    owner: pkg("harness", "agent-runtime"),
    imported: productPkg("helarc", "helarc"),
  },
  {
    name: "Harness production to Test Support",
    accepted: false,
    owner: pkg("harness", "agent-runtime"),
    imported: pkg("tooling", "test-support"),
  },
  {
    name: "Harness test to Test Support",
    accepted: true,
    isTestOnly: true,
    owner: pkg("harness", "agent-runtime"),
    imported: pkg("tooling", "test-support"),
  },
  {
    name: "Product to Harness",
    accepted: true,
    owner: productPkg("helarc", "helarc"),
    imported: pkg("harness", "agent-runtime"),
  },
  {
    name: "Product Desktop to Helarc Core",
    accepted: true,
    owner: productPkg("helarc", "helarc-desktop", "desktop"),
    imported: productPkg("helarc", "helarc", "core"),
  },
  {
    name: "Helarc Core to Code Workspace",
    accepted: true,
    owner: productPkg("helarc", "helarc", "core"),
    imported: productPkg("helarc", "helarc-code-agent", "code-workspace"),
  },
  {
    name: "Code Workspace to Helarc Core",
    accepted: false,
    owner: productPkg("helarc", "helarc-code-agent", "code-workspace"),
    imported: productPkg("helarc", "helarc", "core"),
  },
  {
    name: "Helarc Core to Desktop",
    accepted: false,
    owner: productPkg("helarc", "helarc", "core"),
    imported: productPkg("helarc", "helarc-desktop", "desktop"),
  },
  {
    name: "Product Desktop to Local Environment",
    accepted: true,
    owner: productPkg("helarc", "helarc-desktop", "desktop"),
    imported: productPkg("helarc", "helarc-local-environment", "local-environment"),
  },
  {
    name: "Local Environment to Code Workspace",
    accepted: true,
    owner: productPkg("helarc", "helarc-local-environment", "local-environment"),
    imported: productPkg("helarc", "helarc-code-workspace", "code-workspace"),
  },
  {
    name: "Helarc Core to Local Environment",
    accepted: false,
    owner: productPkg("helarc", "helarc", "core"),
    imported: productPkg("helarc", "helarc-local-environment", "local-environment"),
  },
  {
    name: "Local Environment to Helarc Core",
    accepted: false,
    owner: productPkg("helarc", "helarc-local-environment", "local-environment"),
    imported: productPkg("helarc", "helarc", "core"),
  },
  {
    name: "Product to another Product",
    accepted: false,
    owner: productPkg("helarc", "helarc"),
    imported: productPkg("other", "other-product"),
  },
  {
    name: "Product test to Test Support",
    accepted: true,
    isTestOnly: true,
    owner: productPkg("helarc", "helarc-code-agent"),
    imported: pkg("tooling", "test-support"),
  },
  {
    name: "Test Support to Harness",
    accepted: true,
    owner: pkg("tooling", "test-support"),
    imported: pkg("harness", "agent-core"),
  },
  {
    name: "Test Support to Product",
    accepted: false,
    owner: pkg("tooling", "test-support"),
    imported: productPkg("helarc", "helarc"),
  },
];

function pkg(kind, name) {
  return { kind, name: `@agent-anything/${name}` };
}

function productPkg(productId, name, component = null) {
  return { ...pkg("product", name), productId, component };
}
