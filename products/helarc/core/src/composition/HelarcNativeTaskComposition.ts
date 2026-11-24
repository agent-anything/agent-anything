import {bindModelAgentComposition,snapshotModelAgentCompositionBinding,assertChildModelComposition,OPENAI_RESPONSES,DEEPSEEK_CHAT_COMPLETIONS,OLLAMA_CHAT,
  type ModelAgentCompositionBinding,type ModelInteractionProtocolRef,type ModelPurposeParticipants,type ProtocolRevisionRef} from "@agent-anything/model-interaction/protocol";
import {modelInputValueDigest as digest} from "@agent-anything/model-interaction/input";
import {snapshotContextMaterialRefs} from "@agent-anything/context/material";
import {OPENAI_RESPONSES_ADAPTER,DEEPSEEK_CHAT_ADAPTER,OLLAMA_CHAT_ADAPTER,responsesInputCapacityRefused,deepSeekInputCapacityRefused,ollamaInputCapacityRefused} from "@agent-anything/provider-integrations/native";
import {HELARC_CONTROLLER_CAPABILITY} from "../controller/HelarcController.js";
import {HELARC_NATIVE_TASK_INTERPRETER} from "../controller/native/HelarcNativeTask.js";
import {HelarcNativeTaskExecution,type HelarcNativeTaskExecutionPorts} from "../controller/native/HelarcNativeTaskExecution.js";
import {prepareHelarcResponsesTask,prepareHelarcDeepSeekTask,prepareHelarcOllamaTask,validateHelarcNativeTaskDelivery,
  type HelarcNativeTaskInputPorts} from "../controller/native/HelarcNativeTaskInput.js";
import {interpretHelarcResponses,interpretHelarcDeepSeek,interpretHelarcOllama,validateHelarcResponsesTaskInput,validateHelarcDeepSeekTaskInput,validateHelarcOllamaTaskInput} from "../controller/native/HelarcNativeTaskReaders.js";
import type {HelarcNativeTaskExecutionFactory,HelarcNativeTaskModelBinding,HelarcTaskExecutionComposition} from "./HelarcTaskModelBinding.js";

type Prepare=HelarcNativeTaskExecutionPorts["prepare"];
export interface HelarcNativeTaskCompositionPorts extends Omit<HelarcNativeTaskExecutionPorts,"prepare"|"interruptPreparation"|"interpret"|"validateOriginalInput"|"validateDelivery"|"validateMaterials"|"observe"|"inputRepreparation"> {
  readonly observe:(...args:[...Parameters<HelarcNativeTaskExecutionPorts["observe"]>,import("../run/presentation/HelarcNativePreview.js").HelarcNativePreviewObserver])=>ReturnType<HelarcNativeTaskExecutionPorts["observe"]>;
  readonly preparations:HelarcTaskExecutionComposition["preparations"];
  readonly conditions:(...args:Parameters<Prepare>)=>Promise<HelarcNativeTaskInputPorts["conditions"]>;
  readonly authorizeImport:NonNullable<HelarcNativeTaskInputPorts["authorizeImport"]>;
  readonly auxiliary:readonly ModelPurposeParticipants[];
  readonly supportsAuxiliary?:(participant:ModelPurposeParticipants)=>boolean;
  readonly originalCompositions?:()=>readonly ModelAgentCompositionBinding[]|null;
  /** CRM owns keep/prepare/select. A kept input is a deliberate result of that policy. */
  readonly inputPreparation:{
    select:(arranged:Awaited<ReturnType<Prepare>>,...args:Parameters<Prepare>)=>ReturnType<Prepare>;
    restore:(...args:Parameters<Prepare>)=>Promise<Awaited<ReturnType<Prepare>>|null>;
    interrupt:HelarcNativeTaskExecutionPorts["interruptPreparation"];
    replacement?:Pick<NonNullable<HelarcNativeTaskExecutionPorts["inputRepreparation"]>,"maximum"|"prepare"|"interrupt">;
  };
  /** The selected native Host retains connection/session state after input selection. */
  readonly retainTransport:(arranged:Awaited<ReturnType<Prepare>>,...args:Parameters<Prepare>)=>ReturnType<Prepare>;
}

export function createHelarcResponsesTaskExecution(ports:HelarcNativeTaskCompositionPorts,options:Parameters<typeof prepareHelarcResponsesTask>[2]):HelarcNativeTaskExecutionFactory {
  return binding=>compose(binding,ports,OPENAI_RESPONSES,OPENAI_RESPONSES_ADAPTER,
    (input,p)=>prepareHelarcResponsesTask(input,p,options),interpretHelarcResponses,validateHelarcResponsesTaskInput);
}
export function createHelarcDeepSeekTaskExecution(ports:HelarcNativeTaskCompositionPorts,options:Parameters<typeof prepareHelarcDeepSeekTask>[2]):HelarcNativeTaskExecutionFactory {
  return binding=>compose(binding,ports,DEEPSEEK_CHAT_COMPLETIONS,DEEPSEEK_CHAT_ADAPTER,
    (input,p)=>prepareHelarcDeepSeekTask(input,p,options),interpretHelarcDeepSeek,validateHelarcDeepSeekTaskInput);
}
export function createHelarcOllamaTaskExecution(ports:HelarcNativeTaskCompositionPorts,options:Parameters<typeof prepareHelarcOllamaTask>[2]):HelarcNativeTaskExecutionFactory {
  return binding=>compose(binding,ports,OLLAMA_CHAT,OLLAMA_CHAT_ADAPTER,
    (input,p)=>prepareHelarcOllamaTask(input,p,options),interpretHelarcOllama,validateHelarcOllamaTaskInput);
}
function compose(binding:HelarcNativeTaskModelBinding,ports:HelarcNativeTaskCompositionPorts,protocol:ModelInteractionProtocolRef,adapter:ProtocolRevisionRef,
  prepare:(input:Parameters<Prepare>[0],p:HelarcNativeTaskInputPorts)=>ReturnType<Prepare>,interpret:HelarcNativeTaskExecutionPorts["interpret"],
  validateOriginalInput:HelarcNativeTaskExecutionPorts["validateOriginalInput"]){
  if(digest(binding.model.protocol)!==digest(protocol)||binding.agents.length!==2)throw new TypeError("helarc_native_task_composition_mismatch");
  const available=binding.agents.map(agent=>bindModelAgentComposition({agent:{id:agent.id,revision:agent.revision},protocol,configuration:binding.model,
    adapter:{implementation:adapter,protocol},task:{purpose:{id:HELARC_CONTROLLER_CAPABILITY,revision:"1"},
      input:{implementation:{id:`helarc.${protocol.id}.task-input`,revision:"1"},protocol},interpreter:{implementation:HELARC_NATIVE_TASK_INTERPRETER,protocol}},auxiliary:ports.auxiliary}));
  const original=ports.originalCompositions?.();
  if(original&&original.length!==available.length)throw new TypeError("helarc_native_original_composition_set_changed");
  const compositions=original?available.map(current=>{
    const retained=original.find(value=>digest(value.composition.agent)===digest(current.composition.agent));
    if(!retained)throw new TypeError("helarc_native_original_agent_unavailable");
    const saved=snapshotModelAgentCompositionBinding(retained),{auxiliary,...base}=saved.composition;
    const {auxiliary:supported,...expected}=current.composition;
    if(digest(base)!==digest(expected))throw new TypeError("helarc_native_original_participant_unavailable");
    for(const purpose of auxiliary)if(!supported.some(candidate=>digest(candidate)===digest(purpose))&&!ports.supportsAuxiliary?.(purpose))
      throw new TypeError(`helarc_native_original_auxiliary_unavailable:${purpose.purpose.id}:${purpose.purpose.revision}`);
    return saved;
  }):available;
  assertChildModelComposition(compositions[0]!,compositions[1]!);
  return {compositions,preparations:ports.preparations,taskDecisions:new HelarcNativeTaskExecution({...ports,interpret,validateOriginalInput,
    ...(ports.inputPreparation.replacement?{inputRepreparation:{...ports.inputPreparation.replacement,
      capacityRefused:protocol.id===OPENAI_RESPONSES.id?responsesInputCapacityRefused:protocol.id===DEEPSEEK_CHAT_COMPLETIONS.id?deepSeekInputCapacityRefused:ollamaInputCapacityRefused,
      prepare:async(...args:Parameters<NonNullable<HelarcNativeTaskExecutionPorts["inputRepreparation"]>["prepare"]>)=>{
        const selected=await ports.inputPreparation.replacement!.prepare(...args);
        if(!compositions.some(c=>digest(c)===digest(selected.activity.composition)))throw new TypeError("native_replacement_composition_changed");
        binding.requestBound(args[0].runId,selected.prepared.binding.requestId,binding.controller.createCallableCatalog(args[0].toolExposure,args[0].planLimits,args[0].plan!==null));
        const retained=await ports.retainTransport(selected,args[0],args[1]);
        if(digest(retained.activity)!==digest(selected.activity))throw new TypeError("native_replacement_transport_changed");
        return retained;
      }}}:{}),
    interruptPreparation:(input,context)=>ports.inputPreparation.interrupt(input,context),
    observe:async(...args)=>{
      const preview:typeof binding.preview=event=>{try{binding.preview(event);}catch{/* Display cannot affect native execution. */}};
      try{
        const result=await ports.observe(...args,preview);
        preview({binding:args[1].binding,sequence:Number.MAX_SAFE_INTEGER,value:{},
          disposition:args[2]==="interrupt"?"cancelled":result?"received":"interrupted"});
        return result;
      }catch(error){
        preview({binding:args[1].binding,sequence:Number.MAX_SAFE_INTEGER,value:{},disposition:args[3].cancellation.signal.aborted?"interrupted":"failed",
          code:args[3].cancellation.signal.aborted?"observation_interrupted":"observation_failed"});
        throw error;
      }
    },
    validateDelivery:validateHelarcNativeTaskDelivery,
    validateMaterials:async(proposal,runId)=>{const refs=snapshotContextMaterialRefs(proposal.ending?.materialRefs??[]);
      if(refs.length&&!binding.materials)throw new TypeError("helarc_native_material_validation_required");
      if(binding.materials)await binding.materials.validate(runId,refs);},
    prepare:async(input,context)=>{
      const composition=compositions.find(c=>c.composition.agent.id===input.agent.id&&c.composition.agent.revision===input.agent.revision);
      if(!composition)throw new TypeError("helarc_native_task_agent_unavailable");
      const restored=await ports.inputPreparation.restore(input,context);
      if(restored){
        if(digest(restored.activity.composition)!==digest(composition))throw new TypeError("helarc_native_task_restored_composition_changed");
        binding.requestBound(input.runId,restored.prepared.binding.requestId,binding.controller.createCallableCatalog(input.toolExposure,input.planLimits,input.plan!==null));
        const retained=await ports.retainTransport(restored,input,context);
        if(digest(retained.activity)!==digest(restored.activity))throw new TypeError("helarc_native_task_arrangement_changed");
        return retained;
      }
      const arranged=await prepare(input,{journal:ports.journal,composition,controller:binding.controller,environment:binding.environment(input.runId),
        conditions:await ports.conditions(input,context),authorizeImport:ports.authorizeImport,contextSelections:ports.contextSelections});
      binding.requestBound(input.runId,arranged.prepared.binding.requestId,binding.controller.createCallableCatalog(input.toolExposure,input.planLimits,input.plan!==null));
      const selected=await ports.inputPreparation.select(arranged,input,context),retained=await ports.retainTransport(selected,input,context);
      if(digest(retained.activity)!==digest(arranged.activity))throw new TypeError("helarc_native_task_arrangement_changed");
      return retained;
    }})};
}
