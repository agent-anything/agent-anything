import type { NormalizedTarget } from "./NetDoctorInput.js";

export function parseTarget(rawTarget: string): NormalizedTarget {
  const raw = rawTarget.trim();

  if (raw.length === 0) {
    throw new Error("Target is required.");
  }

  const targetWithScheme = hasScheme(raw) ? raw : `netdoctor://${raw}`;
  const url = new URL(targetWithScheme);
  const protocol = hasScheme(raw) ? url.protocol.replace(/:$/, "") : null;
  const host = url.hostname;
  const port = url.port.length > 0 ? Number(url.port) : null;

  if (host.length === 0) {
    throw new Error("Target host is required.");
  }

  return {
    raw,
    host,
    port,
    protocol,
    normalized: createNormalizedTarget(host, port),
  };
}

function hasScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function createNormalizedTarget(host: string, port: number | null): string {
  if (port === null) {
    return host;
  }

  return `${host}:${port}`;
}
