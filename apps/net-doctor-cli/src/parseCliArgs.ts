export interface NetDoctorCliArgs {
  target: string;
  symptom: string;
}

export function parseCliArgs(args: string[]): NetDoctorCliArgs {
  const values = [...args];
  let target: string | null = null;
  let symptom = "";

  while (values.length > 0) {
    const value = values.shift();

    if (value === undefined) {
      break;
    }

    if (value === "--target" || value === "-t") {
      target = readRequiredValue(values, value);
      continue;
    }

    if (value === "--symptom" || value === "-s") {
      symptom = readRequiredValue(values, value);
      continue;
    }

    if (value === "--help" || value === "-h") {
      throw new CliHelpRequested();
    }

    if (value.startsWith("-")) {
      throw new Error(`Unknown option '${value}'.`);
    }

    target ??= value;
  }

  if (!target) {
    throw new Error("Missing target. Usage: net-doctor --target <host-or-url> [--symptom <text>]");
  }

  return {
    target,
    symptom,
  };
}

export class CliHelpRequested extends Error {
  constructor() {
    super("Help requested.");
    this.name = "CliHelpRequested";
  }
}

function readRequiredValue(values: string[], option: string): string {
  const value = values.shift();

  if (!value || value.startsWith("-")) {
    throw new Error(`Option '${option}' requires a value.`);
  }

  return value;
}
