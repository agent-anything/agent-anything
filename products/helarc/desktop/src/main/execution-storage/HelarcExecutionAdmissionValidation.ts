import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {snapshotModelAgentCompositionBinding,assertChildModelComposition} from "@agent-anything/model-interaction/protocol";
import {snapshotProviderDraft} from "../provider/ProviderDraftValidation.js";
import {legacyPreparationLimitation,validateRetainedContextRunBinding} from "../context/HelarcContextRunBinding.js";
import {nativePreparationLimitation,validateRetainedNativeContextRunBinding,helarcNativeContextTarget} from "../context/HelarcNativeContextRunBinding.js";
import {validHelarcRunCredentialBinding} from "../provider/HelarcRunCredentialBinding.js";
import type {HelarcExecutionAdmission} from "./HelarcExecutionAdmission.js";

/** Validate original composition relationships without resolving secrets or current defaults. */
export function validateRetainedExecutionAdmission(admission:HelarcExecutionAdmission):void {
  if(!Number.isFinite(Date.parse(admission.createdAt))||!admission.commandEnvironment)throw new TypeError("execution_admission_invalid");
  const start=admission.productStart;
  if(start&&(start.kind!=="run_start"||start.threadId!==admission.sessionId||start.runId!==admission.productRunId||
    start.run.id!==admission.productRunId||start.run.taskId!==admission.task.id||
    start.triggeringMessage.content!==admission.task.input.prompt))throw new TypeError("execution_admission_product_start_invalid");
  if(admission.version===3){
    if(!validHelarcRunCredentialBinding(admission.providerCredential,admission.providerProfile.id))throw new TypeError("execution_admission_credential_invalid");
    validateRetainedContextRunBinding(admission.contextBinding);return;
  }
  if(admission.version!==4||"providerProfile" in admission||"providerBinding" in admission||"providerCredential" in admission)
    throw new TypeError("execution_admission_protocol_invalid");
  const {configuration:c,connection,root,delegated}=admission.model;
  const draft={protocol:c.protocol,name:c.name,model:c.model,baseUrl:c.baseUrl,native:c.native,
    observation:c.observation,generationLifetimeMs:c.generationLifetimeMs};
  if(!c.model||digest(snapshotProviderDraft(draft))!==digest(draft))throw new TypeError("execution_admission_configuration_invalid");
  snapshotModelAgentCompositionBinding(root);snapshotModelAgentCompositionBinding(delegated);assertChildModelComposition(root,delegated);
  const configured=root.composition.configuration;
  if(configured.configuration.id!==c.id||configured.configuration.revision!==c.revision||configured.model!==c.model||
    configured.protocol.id!==c.protocol||configured.protocol.revision!=="1"||configured.connectionBinding.id!==c.connectionBindingId||
    configured.connectionBinding.revision!=="1"||!validHelarcRunCredentialBinding(connection,c.id)||connection.kind!=="connection"||
    connection.bindingId!==c.connectionBindingId||connection.acceptanceId!==admission.productRunId||
    connection.pinId!==`${admission.productRunId}:provider-connection`)
    throw new TypeError("execution_admission_native_binding_invalid");
  validateRetainedNativeContextRunBinding(admission.contextBinding);
  if(digest(helarcNativeContextTarget(c,admission.contextBinding.target.artifact))!==digest(admission.contextBinding.target))
    throw new TypeError("execution_admission_native_context_changed");
}

export function originalPreparationLimitation(admission:HelarcExecutionAdmission) {
  return admission.version===3?legacyPreparationLimitation(admission.contextBinding):nativePreparationLimitation(admission.contextBinding);
}

export function validateHelarcExecutionAdmission(admission:HelarcExecutionAdmission):void {
  validateRetainedExecutionAdmission(admission);
  const limitation=originalPreparationLimitation(admission);
  if(limitation)throw new TypeError(limitation.code);
}
