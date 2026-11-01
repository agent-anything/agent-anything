import type {TaskModelSource} from "@agent-anything/agent-runtime/decision";
import {createHelarcInputPreparation} from "./HelarcInputPreparation.js";
import {helarcTaskInputSourceRules} from "./HelarcTaskInputSupply.js";

export function createHelarcTaskPreparation(
  ports:Omit<Parameters<typeof createHelarcInputPreparation<TaskModelSource>>[0],"source"|"describe">,
) {
  return createHelarcInputPreparation({...ports,...helarcTaskInputSourceRules()});
}
