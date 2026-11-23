const $ = (id) => document.getElementById(id);
const DB_NAME = "universal-intelligence-db";
const DB_VERSION = 1;
let db, engine = null, selectedModel = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";
let skillText = "", githubToken = "", connectedRepo = null, activeConversation = [];
let proposedFiles = [];

const titles = {chat:["YOUR PRIVATE WORKSPACE","Assistant"],projects:["LOCAL KNOWLEDGE STORE","Projects & memory"],sync:["CONTROLLED REPOSITORY ACCESS","GitHub sync"],settings:["AGENT CONFIGURATION","Settings"]};

async function initDB(){
  const nativeDB = await new Promise((resolve,reject)=>{
    const request=indexedDB.open(DB_NAME,DB_VERSION);
    request.onupgradeneeded=()=>{
      const database=request.result;
      if(!database.objectStoreNames.contains("conversations")) database.createObjectStore("conversations",{keyPath:"id"});
      if(!database.objectStoreNames.contains("projects")) database.createObjectStore("projects",{keyPath:"id"});
      if(!database.objectStoreNames.contains("meta")) database.createObjectStore("meta");
    };
    request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error);
  });
  const request=(store,method,...args)=>new Promise((resolve,reject)=>{
    const tx=nativeDB.transaction(store,method==="get"||method==="getAll"?"readonly":"readwrite");
    const req=tx.objectStore(store)[method](...args);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
  });
  db={get:(s,k)=>request(s,"get",k),getAll:s=>request(s,"getAll"),put:(s,v,k)=>request(s,"put",v,...(k===undefined?[]:[k])),clear:s=>request(s,"clear")};
}
const uid=()=>crypto.randomUUID();
async function loadSkill(){
  skillText = await db.get("meta", "skillText") || "";
  $("skillState").textContent = skillText ? `Loaded private SKILL.md · ${skillText.length.toLocaleString()} characters` : "No skill loaded. Upload your private SKILL.md here; it will stay in this browser until you approve a GitHub backup.";
}
$("skillUpload").addEventListener("change", async (e)=>{
  const file=e.target.files?.[0]; if(!file)return;
  if(file.size>1024*1024){alert("For safety, the skill file must be under 1 MB.");e.target.value="";return;}
  skillText=await file.text(); await db.put("meta",skillText,"skillText");
  $("skillState").textContent=`Loaded private SKILL.md · ${skillText.length.toLocaleString()} characters`;
  capabilityStatus();
});
function showPanel(name){
  document.querySelectorAll(".panel").forEach(p=>p.classList.remove("active"));
  $("panel-"+name).classList.add("active");
  document.querySelectorAll(".nav").forEach(n=>n.classList.toggle("active",n.dataset.panel===name));
  $("sectionEyebrow").textContent=titles[name][0]; $("sectionTitle").textContent=titles[name][1];
  if(name==="projects") renderProjects();
  if(name==="sync") renderSyncPreview();
}
document.querySelectorAll(".nav").forEach(n=>n.addEventListener("click",()=>showPanel(n.dataset.panel)));
$("newChat").onclick=()=>{activeConversation=[];$("messages").innerHTML="";$("welcome").classList.remove("hidden");showPanel("chat");};
document.querySelectorAll(".suggestion").forEach(b=>b.onclick=()=>{$("promptInput").value=b.dataset.prompt; $("promptInput").focus();});
$("promptInput").addEventListener("input",()=>{$("sendButton").disabled=!$("promptInput").value.trim()||!engine; $("promptInput").style.height="auto"; $("promptInput").style.height=Math.min($("promptInput").scrollHeight,160)+"px";});
$("promptInput").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendMessage();}});
$("sendButton").onclick=sendMessage;
$("modelButton").onclick=()=>showPanel("settings");
$("modelSelect").onchange=e=>selectedModel=e.target.value;

function addMessage(role,text){
  $("welcome").classList.add("hidden");
  const wrap=document.createElement("div");wrap.className="message "+role;
  const av=document.createElement("div");av.className="avatar";av.textContent=role==="user"?"YOU":"✳";
  const bubble=document.createElement("div");bubble.className="bubble";bubble.textContent=text;
  wrap.append(av,bubble);$("messages").append(wrap);$("messages").scrollTop=$("messages").scrollHeight;return bubble;
}
async function loadModel(){
  if(engine)return;
  if(!("gpu" in navigator)){setModelStatus("WebGPU is not available in this browser. Try a recent Chrome or Edge version on supported hardware.");return;}
  $("loadModel").disabled=true;$("modelProgress").classList.remove("hidden");setModelStatus("Loading model library and downloading model…");
  try{
    const webllm=await import("https://esm.sh/@mlc-ai/web-llm");
    engine=await webllm.CreateMLCEngine(selectedModel,{initProgressCallback:(p)=>{
      const pct=Math.round((p.progress||0)*100);$("progressBar").style.width=pct+"%";$("progressPct").textContent=pct+"%";$("progressText").textContent=p.text||"Preparing model…";
    }});
    $("runtimeDot").classList.add("green");$("runtimeStatus").textContent="AI engine ready";$("modelBadge").textContent=selectedModel.split("-").slice(0,2).join(" ");setModelStatus("Model loaded and running in this browser.");
    $("sendButton").disabled=!$("promptInput").value.trim();
  }catch(e){setModelStatus("Model failed to load: "+e.message);engine=null;}
  finally{$("loadModel").disabled=false;}
}
function setModelStatus(s){$("modelStatus").textContent=s;$("progressText").textContent=s;}
$("loadModel").onclick=loadModel;
async function sendMessage(){
  const prompt=$("promptInput").value.trim();if(!prompt||!engine)return;
  $("promptInput").value="";$("promptInput").style.height="auto";$("sendButton").disabled=true;
  activeConversation.push({role:"user",content:prompt});addMessage("user",prompt);
  const reply=addMessage("assistant","Thinking…");
  const system=`You are UNIVERSAL INTELLIGENCE, a general-purpose AI engineering and productivity agent. Follow the user's bundled skill instructions where relevant, but never claim tools or capabilities that this browser app does not implement. You cannot access arbitrary local files, execute shell commands, browse the web, or modify repositories unless the app explicitly provides that capability. Never claim actions were completed unless actually performed. Protect secrets and ask before destructive or external actions.\n\n--- SKILL.md ---\n${skillText.slice(0,60000)}`;
  try{
    const messages=[{role:"system",content:system},...activeConversation.slice(-16)];
    const result=await engine.chat.completions.create({messages,temperature:0.65,max_tokens:1200});
    const answer=result.choices?.[0]?.message?.content||"No response was returned.";reply.textContent=answer;
    activeConversation.push({role:"assistant",content:answer});await saveConversation();
  }catch(e){reply.textContent="Generation error: "+e.message;}
  $("sendButton").disabled=!$("promptInput").value.trim();
}
async function saveConversation(){
  if(!activeConversation.length)return;
  const item={id:"current",updatedAt:new Date().toISOString(),messages:activeConversation};
  await db.put("conversations",item);
}

async function renderProjects(){
  const items=await db.getAll("projects");const host=$("projectList");host.innerHTML="";
  if(!items.length){host.innerHTML='<div class="empty">No projects yet. Create a project to save durable context.</div>';return;}
  items.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).forEach(p=>{
    const el=document.createElement("div");el.className="project";
    const h=document.createElement("h3");h.textContent=p.name;
    const d=document.createElement("p");d.textContent=p.notes||"No notes yet.";
    const meta=document.createElement("div");meta.className="tiny";meta.textContent="Updated "+new Date(p.updatedAt).toLocaleString();
    const edit=document.createElement("button");edit.className="secondary";edit.textContent="Edit";edit.onclick=()=>editProject(p);
    el.append(h,d,meta,edit);host.append(el);
  });
}
function editProject(existing=null){
  const name=prompt("Project name",existing?.name||"");if(name===null||!name.trim())return;
  const notes=prompt("Project notes / reusable context",existing?.notes||"");if(notes===null)return;
  db.put("projects",{id:existing?.id||uid(),name:name.trim(),notes,updatedAt:new Date().toISOString()}).then(renderProjects);
}
$("addProject").onclick=()=>editProject();

function exportPayload(){
  return {format:"universal-intelligence-backup-v1",exportedAt:new Date().toISOString(),skill:skillText,conversations:[],projects:[]};
}
async function buildBackup(){
  const payload=exportPayload();payload.conversations=await db.getAll("conversations");payload.projects=await db.getAll("projects");return payload;
}
$("exportData").onclick=async()=>{
  const data=await buildBackup();download("universal-intelligence-backup.json",JSON.stringify(data,null,2),"application/json");
};
function download(name,content,type){const blob=new Blob([content],{type});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=name;a.click();URL.revokeObjectURL(a.href);}
$("clearData").onclick=async()=>{
  if(!confirm("Permanently delete all conversations and projects stored by this app in this browser? Export a backup first. This cannot be undone."))return;
  await db.clear("conversations");await db.clear("projects");activeConversation=[];$("messages").innerHTML="";$("welcome").classList.remove("hidden");renderProjects();alert("Local app data cleared.");
};

async function githubRequest(path,options={}){
  const response=await fetch("https://api.github.com"+path,{...options,headers:{Accept:"application/vnd.github+json",Authorization:"Bearer "+githubToken,"X-GitHub-Api-Version":"2022-11-28",...(options.headers||{})}});
  const body=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(body.message||"GitHub API error "+response.status);
  return body;
}
$("connectGithub").onclick=async()=>{
  const token=$("githubToken").value.trim(),owner=$("repoOwner").value.trim(),repo=$("repoName").value.trim();
  if(!token||!owner||!repo){$("githubStatus").textContent="Enter token, owner and repository.";return;}
  githubToken=token;
  $("githubStatus").textContent="Checking repository permissions…";
  try{
    const r=await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
    if(!r.private)throw new Error("This repository is public. Choose a private repository.");
    connectedRepo={owner,repo,branch:r.default_branch};
    $("githubStatus").textContent=`Connected: ${owner}/${repo} · private · branch ${r.default_branch}. Token held in memory only.`;
    $("githubToken").value="";
    renderSyncPreview();
  }catch(e){githubToken="";connectedRepo=null;$("githubStatus").textContent="Connection failed: "+e.message;}
};
async function renderSyncPreview(){
  if(!connectedRepo){$("syncPreview").textContent="Connect a repository to prepare a backup preview.";return;}
  const backup=await buildBackup();
  proposedFiles=[{path:"backups/browser-backup.json",content:JSON.stringify(backup,null,2)}];
  if(skillText) proposedFiles.push({path:"SKILL.md",content:skillText});
  $("syncPreview").innerHTML="";
  proposedFiles.forEach(f=>{const row=document.createElement("div");row.className="preview-row";const a=document.createElement("span");a.textContent=f.path;const b=document.createElement("span");b.textContent=(new Blob([f.content]).size/1024).toFixed(1)+" KB";row.append(a,b);$("syncPreview").append(row);});
  $("approveSync").disabled=false;
}
$("disconnectGithub").onclick=()=>{githubToken="";connectedRepo=null;proposedFiles=[];$("githubToken").value="";$("githubStatus").textContent="Disconnected. Token cleared from app memory.";$("approveSync").disabled=true;renderSyncPreview();};
$("approveSync").onclick=async()=>{
  if(!connectedRepo||!githubToken)return;
  const summary=proposedFiles.map(f=>f.path).join("\n");
  if(!confirm("APPROVE UPLOAD to "+connectedRepo.owner+"/"+connectedRepo.repo+"?\n\nFiles:\n"+summary+"\n\nThis will create or update these files in your private repository."))return;
  $("approveSync").disabled=true;
  try{
    for(const file of proposedFiles){
      const base=`/repos/${connectedRepo.owner}/${connectedRepo.repo}/contents/${file.path}`;
      let sha;try{const old=await githubRequest(base);sha=old.sha;}catch(e){if(!String(e.message).includes("Not Found"))throw e;}
      await githubRequest(base,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:"Approved Universal Intelligence backup: "+file.path,content:btoa(unescape(encodeURIComponent(file.content))),branch:connectedRepo.branch,...(sha?{sha}:{})})});
    }
    $("githubStatus").textContent="Approved backup uploaded successfully. Revoke your GitHub token when finished.";
    alert("Approved files uploaded to your private repository.");
  }catch(e){$("githubStatus").textContent="Upload stopped: "+e.message+" Check repository contents before retrying.";}
  finally{$("approveSync").disabled=false;}
};

$("viewSkill").onclick=()=>openModal("Bundled SKILL.md",skillText||"SKILL.md unavailable.");
function openModal(title,body){$("modalTitle").textContent=title;$("modalBody").textContent=body;$("modal").showModal();}
$("closeModal").onclick=()=>$("modal").close();

function capabilityStatus(){
  const rows=[
    ["Browser WebGPU",!!navigator.gpu],
    ["IndexedDB",!!window.indexedDB],
    ["GitHub API","Available when online"],
    ["Bundled SKILL.md",!!skillText],
    ["Local model",!!engine],
    ["Server-side execution",false],
    ["External AI API",false]
  ];
  $("capabilityList").innerHTML="";
  rows.forEach(([k,v])=>{const d=document.createElement("div");d.className="capability";const b=document.createElement("b");b.textContent=typeof v==="boolean"?(v?"Available":"Not provided"):v;d.append(k+" · ",b);$("capabilityList").append(d);});
}
await initDB();
await loadSkill();
const savedConversation=await db.get("conversations","current");
if(savedConversation?.messages?.length){activeConversation=savedConversation.messages;$("welcome").classList.add("hidden");activeConversation.forEach(m=>addMessage(m.role,m.content));}
capabilityStatus();
if(!navigator.gpu){$("runtimeStatus").textContent="WebGPU unavailable";$("runtimeDot").classList.remove("green");}
if("serviceWorker" in navigator && location.protocol.startsWith("http"))navigator.serviceWorker.register("./sw.js").catch(()=>{});
