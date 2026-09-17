# Native Process Helper

Windows x64 commands require the Rust helper built by the Local Environment
package. Install Rust through rustup and the Visual Studio C++ build tools with
the Windows SDK. The crate pins its toolchain and dependencies; Cargo uses the
lockfile and static CRT linkage. Use the repository's fnm Node and pnpm for the
normal workspace build.

`pnpm --filter @agent-anything/helarc-local-environment build` produces the
helper, its protocol/build/architecture/SHA-256 manifest, and a test fixture in
`native-artifacts/win32-x64`. These are build outputs, not source-controlled
binaries. The runtime verifies the helper before starting commands. It never
downloads or compiles a missing helper and does not fall back to taskkill.

Distribution must preserve `native-artifacts` adjacent to `dist` in the Local
Environment package, outside ASAR (or in the corresponding unpacked package
directory). The application currently uses a workspace/package layout, not an
installer. Desktop `package:check` verifies this artifact alongside renderer
and preload readiness. Test fixtures are not needed for end-user execution.

The helper owns one Job per command, independent of Tool invocation duration.
It is a process lifecycle facility, not a filesystem or network Sandbox. POSIX
uses process groups and explicitly reports its weaker containment and Host-loss
guarantees. Windows integration tests do not establish POSIX coverage.
