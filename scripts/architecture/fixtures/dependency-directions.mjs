export const repositoryDirectionFixtures = [
  {
    name: "Harness to Harness",
    accepted: true,
    owner: pkg("harness", "runtime"),
    imported: pkg("harness", "foundation"),
  },
  {
    name: "Harness to Product",
    accepted: false,
    owner: pkg("harness", "runtime"),
    imported: productPkg("helarc", "helarc"),
  },
  {
    name: "Harness production to Test Support",
    accepted: false,
    owner: pkg("harness", "runtime"),
    imported: pkg("tooling", "test-support"),
  },
  {
    name: "Harness test to Test Support",
    accepted: true,
    isTestOnly: true,
    owner: pkg("harness", "runtime"),
    imported: pkg("tooling", "test-support"),
  },
  {
    name: "Product to Harness",
    accepted: true,
    owner: productPkg("helarc", "helarc"),
    imported: pkg("harness", "runtime"),
  },
  {
    name: "Product component to same Product component",
    accepted: true,
    owner: productPkg("helarc", "helarc-desktop"),
    imported: productPkg("helarc", "helarc"),
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
    imported: pkg("harness", "foundation"),
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

function productPkg(productId, name) {
  return { ...pkg("product", name), productId };
}
