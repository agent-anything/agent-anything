# NetDoctor Phase1 Release Check

NetDoctor Phase1 is ready to package when these commands pass from the repository root:

```powershell
pnpm test
pnpm typecheck
pnpm build
pnpm --filter net-doctor run package
```

The package script uses:

```powershell
vsce package --no-dependencies --allow-missing-repository --skip-license
```

This is intentional because `net-doctor` depends on workspace platform packages
through `workspace:*` dependencies. `vsce` dependency detection uses `npm list`,
which does not understand pnpm workspace dependencies. The `vscode:prepublish`
script runs `build:extension`, which bundles `src/extension.ts` and the required
workspace runtime packages into `dist/extension.js` with `esbuild`.

`--allow-missing-repository` and `--skip-license` are Phase1 packaging choices
because this product package is still part of the monorepo and does not yet have
standalone release metadata in `products/net-doctor/`. Formal publication should
replace those flags with product-level repository and license files.

The generated `.vsix` should include:

- `package.json`
- `README.md`
- `dist/extension.js` bundled extension runtime
- supporting `dist/**/*.js` runtime files

The generated `.vsix` should not include:

- TypeScript source files
- test files or compiled test files
- source maps
- `node_modules`
- local `.vscode` files
- existing `.vsix` artifacts
