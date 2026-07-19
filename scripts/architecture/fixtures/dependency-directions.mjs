export const repositoryDirectionFixtures = [
  { name: "platform to platform", accepted: true, owner: pkg("platform", "platform-a"), imported: pkg("platform", "platform-b") },
  { name: "platform to product", accepted: false, owner: pkg("platform", "platform-a"), imported: pkg("product", "product-a") },
  { name: "platform to app", accepted: false, owner: pkg("platform", "platform-a"), imported: pkg("app", "app-a") },
  { name: "product to platform", accepted: true, owner: pkg("product", "product-a"), imported: pkg("platform", "platform-a") },
  { name: "product self", accepted: true, owner: pkg("product", "product-a"), imported: pkg("product", "product-a") },
  { name: "product to another product", accepted: false, owner: pkg("product", "product-a"), imported: pkg("product", "product-b") },
  { name: "product to app", accepted: false, owner: pkg("product", "product-a"), imported: pkg("app", "app-a") },
  { name: "app to platform", accepted: true, owner: pkg("app", "app-a"), imported: pkg("platform", "platform-a") },
  { name: "app to product", accepted: true, owner: pkg("app", "app-a"), imported: pkg("product", "product-a") },
  { name: "app self", accepted: true, owner: pkg("app", "app-a"), imported: pkg("app", "app-a") },
  { name: "app to another app", accepted: false, owner: pkg("app", "app-a"), imported: pkg("app", "app-b") },
];

function pkg(kind, name) {
  return { kind, name: `@agent-anything/${name}` };
}
