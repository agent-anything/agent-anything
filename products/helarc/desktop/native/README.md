# Windows Credential Helper

Desktop owns this helper because it handles local configuration secrets, not
model-visible commands or workspace execution. It uses the repository's pinned
Rust/MSVC toolchain and `windows-sys` Win32 declarations.

`build:main` builds the locked x64 target and produces a digest manifest under
`native-artifacts/win32-x64`. Distribute the executable and manifest together
outside ASAR at that relative location. `package:check` validates the artifact.
Non-Windows builds use Electron safeStorage without the helper.

The single-request protocol uses bounded stdin/stdout JSON. No secret is a
command-line argument, environment value, plaintext file or log. Only generic
credentials are supported. Read accepts one exact target and an explicit blob
encoding. Create/delete accept only generated `Helarc/Provider/provider-...`
targets; create refuses an existing target. Credentials persist for the current
Windows user on this machine. This does not isolate them from other applications
running as the same user.

The Windows integration test creates a unique dummy credential and deletes it
in `finally`. It never reads or mutates actual user credentials. Unit tests for
encoding run with `cargo test --locked` in `credential-helper`.
