const REQUIRED_TEST_COMMANDS = Object.freeze([
  "test",
  "test:conformance",
  "test:evaluation",
  "test:phase29",
]);

export function evaluateRepositoryCommands(manifest) {
  const violations = [];
  const scripts = isRecord(manifest?.scripts) ? manifest.scripts : {};

  for (const name of REQUIRED_TEST_COMMANDS) {
    if (typeof scripts[name] !== "string" || scripts[name].trim().length === 0) {
      violations.push(violation(
        "repository_test_command_missing",
        `Root package must define a non-empty '${name}' command.`,
      ));
    }
  }

  if (Object.hasOwn(scripts, "conformance:test")) {
    violations.push(violation(
      "removed_conformance_command",
      "Root package must not retain the removed 'conformance:test' alias.",
    ));
  }

  const commands = REQUIRED_TEST_COMMANDS
    .map((name) => [name, scripts[name]])
    .filter((entry) => typeof entry[1] === "string");
  for (let index = 0; index < commands.length; index += 1) {
    for (let candidate = index + 1; candidate < commands.length; candidate += 1) {
      if (commands[index][1] === commands[candidate][1]) {
        violations.push(violation(
          "repository_test_commands_conflated",
          `'${commands[index][0]}' and '${commands[candidate][0]}' must remain distinct commands.`,
        ));
      }
    }
  }

  const evaluationCommand = scripts["test:evaluation"];
  if (
    typeof evaluationCommand === "string" &&
    /baseline:candidate|baseline\/HelarcPhase26Baseline/.test(evaluationCommand)
  ) {
    violations.push(violation(
      "evaluation_test_writes_baseline",
      "'test:evaluation' must not invoke a Baseline candidate or accepted-Baseline write path.",
    ));
  }

  const candidateCommand = scripts["evaluation:baseline:candidate"];
  if (
    typeof candidateCommand !== "string" ||
    !candidateCommand.includes("@agent-anything/test-support build") ||
    !candidateCommand.includes("@agent-anything/test-support evaluation:baseline:candidate") ||
    candidateCommand.includes("...")
  ) {
    violations.push(violation(
      "evaluation_candidate_command_invalid",
      "Baseline candidate command must build Test Support and invoke its explicit no-write candidate command.",
    ));
  }

  return violations;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function violation(rule, message) {
  return { rule, message };
}
