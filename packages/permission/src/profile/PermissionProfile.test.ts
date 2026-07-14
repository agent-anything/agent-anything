import type { ManagedPermissionConstraints } from "@agent-anything/governance/managed-permission";
import { describe, expect, it } from "vitest";
import type { PermissionProfileDefinition } from "./PermissionProfile.js";
import { PermissionProfileResolutionError } from "./PermissionProfileResolutionError.js";
import {
  projectControllerPermissionProfile,
  projectPermissionProfile,
} from "./projectPermissionProfile.js";
import { resolvePermissionProfile } from "./resolvePermissionProfile.js";

describe("resolvePermissionProfile", () => {
  it("resolves built-in workspace permissions deterministically on Windows", () => {
    const profile = resolvePermissionProfile({
      profileId: ":workspace",
      profiles: [],
      environment: {
        environmentId: "local-windows",
        platform: "win32",
        workspaceRoots: [
          { rootId: "secondary", path: "c:\\Shared\\Project\\" },
          { rootId: "primary", path: "d:\\Projects\\Example\\" },
        ],
      },
      managedConstraints: noManagedConstraints(),
    });

    expect(profile.sourceProfileIds).toEqual([":read-only", ":workspace"]);
    expect(profile.workspaceRoots).toEqual([
      { rootId: "primary", canonicalPath: "D:/Projects/Example" },
      { rootId: "secondary", canonicalPath: "C:/Shared/Project" },
    ]);
    expect(profile.fileSystem.entries.map((entry) => entry.access)).toEqual([
      "write",
      "read",
      "write",
      "read",
    ]);
    expect(profile.network.enabled).toBe(false);
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.fileSystem.entries)).toBe(true);
    expect(Object.isFrozen(profile.workspaceRoots[0])).toBe(true);
  });

  it("resolves additive inheritance, canonical domains, and filesystem precedence", () => {
    const profiles: PermissionProfileDefinition[] = [
      profileDefinition({
        id: "base",
        extends: ":workspace",
        network: {
          enabled: true,
          allowedDomains: ["EXAMPLE.com.", "*.Services.Example.com"],
          deniedDomains: ["blocked.example.com"],
        },
        fileSystem: [
          {
            target: {
              kind: "workspace_glob",
              rootId: "repo",
              pattern: "src/**",
            },
            access: "read",
          },
        ],
        metadata: { source: "base", shared: "base" },
      }),
      profileDefinition({
        id: "child",
        extends: "base",
        enforcement: "external",
        network: {
          enabled: false,
          allowedDomains: ["api.example.com"],
          deniedDomains: ["BLOCKED.example.com."],
        },
        fileSystem: ["read", "write", "deny"].map((access) => ({
          target: {
            kind: "workspace_path" as const,
            rootId: "repo",
            path: "src/index.ts",
          },
          access: access as "read" | "write" | "deny",
        })),
        metadata: { shared: "child", selected: true },
      }),
    ];

    const profile = resolvePermissionProfile({
      profileId: "child",
      profiles,
      environment: portableEnvironment(),
      managedConstraints: noManagedConstraints(),
    });

    expect(profile.sourceProfileIds).toEqual([
      ":read-only",
      ":workspace",
      "base",
      "child",
    ]);
    expect(profile.enforcement).toBe("external");
    expect(profile.network.enabled).toBe(true);
    expect(profile.network.profileAllowedDomains).toEqual([
      "*.services.example.com",
      "api.example.com",
      "example.com",
    ]);
    expect(profile.network.deniedDomains).toEqual(["blocked.example.com"]);
    expect(profile.metadata).toEqual({
      source: "base",
      shared: "child",
      selected: true,
    });

    const exactEntries = profile.fileSystem.entries.filter(
      (entry) =>
        entry.target.kind === "absolute_path" &&
        entry.target.path === "/work/repo/src/index.ts",
    );
    expect(exactEntries.map((entry) => entry.access)).toEqual([
      "deny",
      "write",
      "read",
    ]);
    expect(exactEntries[0]?.specificity).toBeGreaterThan(
      profile.fileSystem.entries.find(
        (entry) => entry.target.kind === "canonical_glob",
      )?.specificity ?? 0,
    );
  });

  it("applies managed selection, filesystem ceilings, and network restrictions last", () => {
    const profile = resolvePermissionProfile({
      profileId: "networked",
      profiles: [
        profileDefinition({
          id: "networked",
          extends: ":workspace",
          network: {
            enabled: true,
            allowedDomains: ["example.com", "api.example.com"],
            deniedDomains: ["profile-denied.example.com"],
          },
        }),
      ],
      environment: portableEnvironment(),
      managedConstraints: {
        constraintSetId: "enterprise-default",
        selectableProfiles: {
          allowedProfileIds: ["networked"],
          deniedProfileIds: [":danger-full-access"],
        },
        fileSystem: [
          {
            target: {
              kind: "workspace_path",
              rootId: "repo",
              path: "secrets",
            },
            maximumAccess: "none",
          },
          {
            target: {
              kind: "workspace_glob",
              rootId: "repo",
              pattern: "generated/**",
            },
            maximumAccess: "read",
          },
        ],
        network: {
          enabled: true,
          allowedDomains: ["API.EXAMPLE.COM."],
          deniedDomains: ["managed-denied.example.com"],
        },
        allowUnenforcedExecution: false,
      },
    });

    expect(profile.managedConstraintSetId).toBe("enterprise-default");
    expect(profile.fileSystem.managedCeilings).toMatchObject([
      {
        maximumAccess: "none",
        target: { kind: "absolute_path", path: "/work/repo/secrets" },
      },
      {
        maximumAccess: "read",
        target: { kind: "canonical_glob", pattern: "/work/repo/generated/**" },
      },
    ]);
    expect(profile.network).toEqual({
      enabled: true,
      profileAllowedDomains: ["api.example.com", "example.com"],
      managedAllowedDomains: ["api.example.com"],
      deniedDomains: [
        "managed-denied.example.com",
        "profile-denied.example.com",
      ],
    });
  });

  it("rejects managed profile denial and forbidden disabled enforcement", () => {
    expectResolutionError(
      () =>
        resolvePermissionProfile({
          profileId: ":workspace",
          profiles: [],
          environment: portableEnvironment(),
          managedConstraints: {
            ...noManagedConstraints(),
            selectableProfiles: {
              allowedProfileIds: null,
              deniedProfileIds: [":workspace"],
            },
          },
        }),
      "profile_denied",
    );

    expectResolutionError(
      () =>
        resolvePermissionProfile({
          profileId: ":danger-full-access",
          profiles: [],
          environment: portableEnvironment(),
          managedConstraints: {
            ...noManagedConstraints(),
            allowUnenforcedExecution: false,
          },
        }),
      "unenforced_execution_forbidden",
    );
  });

  it("rejects unknown bases and inheritance cycles", () => {
    expectResolutionError(
      () =>
        resolvePermissionProfile({
          profileId: "child",
          profiles: [profileDefinition({ id: "child", extends: "missing" })],
          environment: portableEnvironment(),
          managedConstraints: noManagedConstraints(),
        }),
      "unknown_base_profile",
    );

    expectResolutionError(
      () =>
        resolvePermissionProfile({
          profileId: "one",
          profiles: [
            profileDefinition({ id: "one", extends: "two" }),
            profileDefinition({ id: "two", extends: "one" }),
          ],
          environment: portableEnvironment(),
          managedConstraints: noManagedConstraints(),
        }),
      "inheritance_cycle",
    );
  });

  it("rejects unsafe roots, workspace escapes, and uncanonicalizable domains", () => {
    expectResolutionError(
      () =>
        resolvePermissionProfile({
          profileId: ":workspace",
          profiles: [],
          environment: {
            environmentId: "portable",
            platform: "posix",
            workspaceRoots: [{ rootId: "repo", path: "relative/repo" }],
          },
          managedConstraints: noManagedConstraints(),
        }),
      "invalid_path",
    );

    expectResolutionError(
      () =>
        resolvePermissionProfile({
          profileId: "escape",
          profiles: [
            profileDefinition({
              id: "escape",
              fileSystem: [
                {
                  target: {
                    kind: "workspace_path",
                    rootId: "repo",
                    path: "../outside",
                  },
                  access: "read",
                },
              ],
            }),
          ],
          environment: portableEnvironment(),
          managedConstraints: noManagedConstraints(),
        }),
      "path_outside_workspace",
    );

    expectResolutionError(
      () =>
        resolvePermissionProfile({
          profileId: "bad-domain",
          profiles: [
            profileDefinition({
              id: "bad-domain",
              network: {
                enabled: true,
                allowedDomains: ["https://example.com/path"],
                deniedDomains: [],
              },
            }),
          ],
          environment: portableEnvironment(),
          managedConstraints: noManagedConstraints(),
        }),
      "invalid_domain",
    );
  });

  it("copies and deeply freezes metadata instead of retaining caller objects", () => {
    const metadata = { nested: { value: "before" }, values: [1, 2] };
    const definition = profileDefinition({ id: "immutable", metadata });
    const profile = resolvePermissionProfile({
      profileId: "immutable",
      profiles: [definition],
      environment: portableEnvironment(),
      managedConstraints: noManagedConstraints(),
    });

    metadata.nested.value = "after";
    metadata.values.push(3);

    expect(profile.metadata).toEqual({
      nested: { value: "before" },
      values: [1, 2],
    });
    expect(Object.isFrozen(profile.metadata)).toBe(true);
    expect(Object.isFrozen(profile.metadata.nested)).toBe(true);
    expect(Object.isFrozen(profile.metadata.values)).toBe(true);
  });

  it("creates immutable projections without paths, globs, domains, or metadata", () => {
    const profile = resolvePermissionProfile({
      profileId: "projected",
      profiles: [
        profileDefinition({
          id: "projected",
          extends: ":workspace",
          network: {
            enabled: true,
            allowedDomains: ["private.example.com"],
            deniedDomains: [],
          },
          metadata: { credentialRef: "must-not-leak" },
        }),
      ],
      environment: portableEnvironment(),
      managedConstraints: noManagedConstraints(),
    });

    const safe = projectPermissionProfile(profile);
    const controller = projectControllerPermissionProfile(profile, true);
    const serialized = JSON.stringify({ safe, controller });

    expect(safe.network.profileRestricted).toBe(true);
    expect(controller.canRequestAdditionalPermissions).toBe(true);
    expect(Object.isFrozen(safe)).toBe(true);
    expect(Object.isFrozen(controller)).toBe(true);
    expect(serialized).not.toContain("/work/repo");
    expect(serialized).not.toContain("private.example.com");
    expect(serialized).not.toContain("credentialRef");
  });
});

function noManagedConstraints(): ManagedPermissionConstraints {
  return {
    constraintSetId: "none",
    selectableProfiles: {
      allowedProfileIds: null,
      deniedProfileIds: [],
    },
    fileSystem: [],
    network: {
      enabled: null,
      allowedDomains: [],
      deniedDomains: [],
    },
    allowUnenforcedExecution: true,
  };
}

function portableEnvironment() {
  return {
    environmentId: "portable-local",
    platform: "posix" as const,
    workspaceRoots: [{ rootId: "repo", path: "/work/repo" }],
  };
}

function profileDefinition(
  input: Partial<PermissionProfileDefinition> & Pick<PermissionProfileDefinition, "id">,
): PermissionProfileDefinition {
  return {
    id: input.id,
    extends: input.extends ?? null,
    enforcement: input.enforcement ?? "managed",
    unrestrictedFileSystem: input.unrestrictedFileSystem ?? false,
    fileSystem: input.fileSystem ?? [],
    network: input.network ?? {
      enabled: false,
      allowedDomains: [],
      deniedDomains: [],
    },
    metadata: input.metadata ?? {},
  };
}

function expectResolutionError(
  operation: () => unknown,
  code: PermissionProfileResolutionError["code"],
): void {
  try {
    operation();
    throw new Error(`Expected permission profile resolution error '${code}'.`);
  } catch (error) {
    expect(error).toBeInstanceOf(PermissionProfileResolutionError);
    expect((error as PermissionProfileResolutionError).code).toBe(code);
  }
}
