export const repositoryDirectionFixtures = [
  { name: "harness to harness", accepted: true, owner: pkg("harness", "harness-a"), imported: pkg("harness", "harness-b") },
  { name: "harness to transitional package", accepted: false, owner: pkg("harness", "harness-a"), imported: pkg("platform", "platform-a") },
  { name: "harness to product", accepted: false, owner: pkg("harness", "harness-a"), imported: pkg("product", "product-a") },
  { name: "transitional package to harness", accepted: true, owner: pkg("platform", "platform-a"), imported: pkg("harness", "harness-a") },
  { name: "platform to platform", accepted: true, owner: pkg("platform", "platform-a"), imported: pkg("platform", "platform-b") },
  { name: "platform to product", accepted: false, owner: pkg("platform", "platform-a"), imported: pkg("product", "product-a") },
  { name: "platform to app", accepted: false, owner: pkg("platform", "platform-a"), imported: pkg("app", "app-a") },
  { name: "product to platform", accepted: true, owner: pkg("product", "product-a"), imported: pkg("platform", "platform-a") },
  { name: "product self", accepted: true, owner: productPkg("helarc", "product-a"), imported: productPkg("helarc", "product-a") },
  { name: "product component to same product component", accepted: true, owner: productPkg("helarc", "product-a"), imported: productPkg("helarc", "product-b") },
  { name: "product to another product", accepted: false, owner: productPkg("helarc", "product-a"), imported: productPkg("other", "product-b") },
  { name: "product to app", accepted: false, owner: pkg("product", "product-a"), imported: pkg("app", "app-a") },
  { name: "app to platform", accepted: true, owner: pkg("app", "app-a"), imported: pkg("platform", "platform-a") },
  { name: "app to product", accepted: true, owner: pkg("app", "app-a"), imported: pkg("product", "product-a") },
  { name: "app self", accepted: true, owner: pkg("app", "app-a"), imported: pkg("app", "app-a") },
  { name: "app to another app", accepted: false, owner: pkg("app", "app-a"), imported: pkg("app", "app-b") },
];

function pkg(kind, name) {
  return { kind, name: `@agent-anything/${name}` };
}

function productPkg(productId, name) {
  return { ...pkg("product", name), productId };
}
