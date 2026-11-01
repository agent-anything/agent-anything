module.exports=async function taskInputSource(provider, suppliedSource=null, options={}) {
  const {createHelarcAgent,createHelarcDelegatedWorkerAgent}=await import("@agent-anything/helarc/agent");
  const {createDefaultHelarcInstructionSettings}=await import("@agent-anything/helarc/configuration");
  const {createAgentInstructionBinding}=await import("@agent-anything/agent-runtime/instructions");
  const {createToolRegistrationSnapshot}=await import("@agent-anything/tools/registration");
  const {createFixedLocalToolSelection}=await import("@agent-anything/tools/selection");
  const {createOperationDefinitionCatalog}=await import("@agent-anything/operation-catalog/catalog");
  const {createExactModelWorkingView}=await import("@agent-anything/model-interaction/input");
  const {createHelarcControllerProtocolComposition,HELARC_CONTROLLER_CONTROL_GUIDANCE}=await import("@agent-anything/helarc/controller");
  const {createHelarcTaskModelBinding}=await import("@agent-anything/helarc/composition");
  const {createHelarcToolGuidanceRelease,createHelarcToolGuidanceCatalog,resolveHelarcToolGuidance,createHelarcBaselineToolGuidanceSource,findHelarcBaselineToolContract}=await import("@agent-anything/helarc/tools");
  const settings=createDefaultHelarcInstructionSettings();
  const agent=createHelarcAgent({instructionSettings:settings,target:"production",providerId:provider.descriptor.id,modelId:provider.modelContext.target.model});
  const delegatedAgent=createHelarcDelegatedWorkerAgent({instructionSettings:settings,providerId:provider.descriptor.id,modelId:provider.modelContext.target.model});
  const descendant=options.delegation?await (async()=>{
    const {pathToFileURL}=require("node:url"),{join}=require("node:path");
    const {createHelarcDescendantAgentContribution}=await import(pathToFileURL(join(__dirname,"../../../core/dist/agent/HelarcDescendantAgent.js")));
    return createHelarcDescendantAgentContribution(delegatedAgent,"2026-10-30T00:00:00.000Z",undefined,options.materialAccess,options.materialHandoff,options.reportHandoff);
  })():null;
  const runId="root",createdAt="2026-10-30T00:00:00.000Z";
  const question=findHelarcBaselineToolContract("AskUserQuestion"),toolRef={tool:{namespace:"helarc",name:"ask-user-question"},revision:"2"};
  const {createHelarcContextAccess}=await import(new URL("../../../core/dist/tools/HelarcContextAccess.js",require("node:url").pathToFileURL(__filename)));
  const contextAccess=options.materialAccess?createHelarcContextAccess(createdAt,options.materialAccess):[];
  const operationCatalog=createOperationDefinitionCatalog({id:"empty",revision:"1",entries:contextAccess.map(value=>value.operation)});
  const registration=createToolRegistrationSnapshot(operationCatalog,[{admissionId:"question",allowedOrigins:["model"],admittedAt:createdAt,
    descriptor:{ref:toolRef,name:question.name,description:question.description,
      inputSchema:options.questionSchemaDescription?{...question.inputSchema,description:options.questionSchemaDescription}:question.inputSchema,
      outputSchema:question.outputSchema,annotations:question.annotations,
      schemaRevisions:{dialect:"json-schema-2020-12",input:"2",output:"2",translation:"native-2"},
      source:{kind:"product",sourceId:"helarc",sourceRevision:"2",activationEpoch:null},
      binding:{kind:"interaction",protocol:{owner:"helarc",kind:"clarification",revision:"1"},blockingScope:"branch",revision:"1"}}},...(descendant?.tools??[]).map(registration=>
        options.delegationSchemaDescription?{...registration,descriptor:{...registration.descriptor,inputSchema:{...registration.descriptor.inputSchema,description:options.delegationSchemaDescription}}}:registration),...contextAccess.map(value=>value.tool)]);
  const catalog=registration.toolCatalog;
  const selection=createFixedLocalToolSelection(registration,operationCatalog,options.delegation?registration.registrations
    .filter(r=>["Agent","SendMessage","ContextMaterialRead","ContextMaterialSearch"].includes(r.descriptor.name)).map(r=>({tool:r.descriptor.ref,origins:["model"]})):[]);
  const source=suppliedSource??{runId,iteration:1,agent,instructionBinding:createAgentInstructionBinding({run:{id:runId},agent,effectiveFromRunRevision:0,supersedes:null}),
    task:{id:"task",kind:"helarc.code-task",input:{prompt:options.prompt??"Report TARGET 7391 using final_result. No operations are needed."},createdAt,metadata:{}},inputItems:[],
    toolExposure:{schemaVersion:1,id:"exposure",selectionRevision:selection.revision,contentRevision:"content",basisRevision:"basis",consumer:"controller",controllerRequestId:"request",
      exposedTools:catalog.tools.map(tool=>tool.ref),omittedToolCount:0,omissionReasons:[],catalog},
    interaction:{id:"interaction",revision:"1",workingView:createExactModelWorkingView({sections:[],recipientRunId:runId,boundary:"history"}),messages:[],unsettledCalls:[],settledCallCount:0,latestTurn:null},
    context:{id:"projection",requestId:"projection-request",activeContext:{id:"context",runId,version:1},estimator:{id:"bytes",revision:"1",unit:"bytes",accuracy:"exact"},
      blocks:[],accounting:{unit:"bytes",amount:0},manifestId:"manifest",createdAt},
    contextManifest:{id:"manifest",projectionId:"projection",requestId:"projection-request",activeContext:{id:"context",runId,version:1},profile:{id:"profile",revision:"1"},
      policy:{id:"policy",revision:"1"},estimator:{id:"bytes",revision:"1",unit:"bytes",accuracy:"exact"},budget:{unit:"bytes",maximum:262144},accounting:{unit:"bytes",consideredItems:0,projectedItems:0,projectedAmount:0}},
    plan:null,planLimits:{maxSteps:8,maxStepLength:500,maxExplanationLength:2000},
    permission:{profile:{profileId:"isolated",sourceProfileIds:["isolated"],environmentId:"isolated",enforcement:"enforced",workspaceRootCount:0,
      fileSystem:{unrestricted:false,allowsRead:false,allowsWrite:false,hasDenials:false,managed:false},process:{unrestricted:false},
      network:{enabled:false,profileRestricted:false,managedRestricted:false,hasDenials:false},managedConstraintSetId:"isolated",canRequestAdditionalPermissions:false},
      authority:{hasAdditionalFileSystemRead:false,hasAdditionalFileSystemWrite:false,hasAdditionalNetwork:false,actionCoverageCount:0,runGrantCount:0,sessionAuthorityCount:0,policyAmendmentCount:0},
      approval:{canRequest:false,reviewer:"user",pendingCount:0}},pending:[],descendants:{active:[],continuations:[]},workspace:null,
    identity:{id:"isolated",kind:"anonymous",displayName:"Isolated verification",metadata:{}},metadata:{}};
  const guidanceSources=catalog.tools.map(tool=>createHelarcBaselineToolGuidanceSource(tool.name,tool.ref,null));
  const release=createHelarcToolGuidanceRelease({id:"isolated",guidanceProfileRevision:"1",tools:guidanceSources.map(s=>s.tool),sources:guidanceSources.map(s=>s.ref),createdAt,reviewedAt:createdAt});
  const toolGuidance=resolveHelarcToolGuidance({catalog:createHelarcToolGuidanceCatalog({sources:guidanceSources,releases:[release]}),release:release.ref,
    providerId:provider.descriptor.id,modelId:provider.modelContext.target.model,toolSelectionRevision:source.toolExposure.selectionRevision,tools:registration.registrations});
  const protocol=createHelarcControllerProtocolComposition({instructionSettings:settings,toolGuidance,controlGuidance:HELARC_CONTROLLER_CONTROL_GUIDANCE});
  const binding=createHelarcTaskModelBinding({agents:[agent,delegatedAgent],protocol,delivery:{mode:"buffered"},...(options.materialAccess?{materials:options.materialAccess}:{})});
  const request=binding.buildRequest(source,{attemptNumber:1,correction:null,target:provider.modelContext.target,requestedOutput:provider.modelContext.requestedOutput});
  return {source,request,agent,registration,selection,binding,delegatedAgent,delegation:descendant?.delegation,contextAccess};
};
