import {
  createSandboxExecutionGateway,
  type CreateSandboxExecutionGatewayInput,
  type SandboxExecutionGateway,
} from "@agent-anything/action-execution/sandbox";

export function createHelarcLocalSandboxGateway(
  input: CreateSandboxExecutionGatewayInput,
): SandboxExecutionGateway {
  return createSandboxExecutionGateway(input);
}
