#!/usr/bin/env node
import { CliHelpRequested, parseCliArgs } from "./parseCliArgs.js";
import { runNetDoctorCli } from "./runNetDoctorCli.js";

try {
  const args = parseCliArgs(process.argv.slice(2));
  const result = await runNetDoctorCli({ args });
  process.exitCode = result.exitCode;
} catch (error) {
  if (error instanceof CliHelpRequested) {
    printHelp();
    process.exitCode = 0;
  } else {
    console.error(error instanceof Error ? error.message : "NetDoctor CLI failed.");
    printHelp();
    process.exitCode = 1;
  }
}

function printHelp(): void {
  console.log("Usage: net-doctor --target <host-or-url> [--symptom <text>] [--permission trusted|ask|deny]");
}
