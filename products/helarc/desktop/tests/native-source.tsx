import React from "react";
import {createRoot} from "react-dom/client";
import {ConversationEntries} from "../src/renderer/conversation/ConversationEntries.js";
import {ConversationReadingBudget} from "../src/renderer/conversation/ConversationReadingBudget.js";
import "../src/renderer/styles.css";
import "../src/renderer/workbench/workbench.css";
import "../src/renderer/conversation/activity.css";
const page=await window.helarc.readConversation({threadId:"thread",scope:{threadId:"thread",productRunId:"product",runId:"root"},position:{kind:"latest"}});
if(page.status!=="page")throw new Error(page.code);
const snapshot={activeThread:{id:"thread",artifacts:[]}} as never;
createRoot(document.getElementById("root")!).render(<main style={{maxWidth:1000,margin:"0 auto",padding:16}}>
  <ConversationReadingBudget><ConversationEntries entries={page.entries} snapshot={snapshot} visible live={false} revision={1}
    onInspect={()=>{}} attempts={[]} syncedCommitKey=""/></ConversationReadingBudget>
</main>);
