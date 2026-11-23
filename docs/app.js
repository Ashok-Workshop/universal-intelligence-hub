const $ = (id) => document.getElementById(id);
const DB_NAME = "universal-intelligence-db";
const DB_VERSION = 1;
let db, engine = null, selectedModel = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";
let skillText = "", githubToken = "", connectedRepo = null, activeConversation = [];
let proposedFiles = [];

// ---------------- ADVANCED SKILL RETRIEVAL ----------------
// The complete original SKILL.md remains unchanged in IndexedDB.
let skillChunks = [];

function buildSkillChunks(source) {
  if (!source || !source.trim()) return [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const chunks = [];
  let headingStack = [];
  let body = [];

  function flush() {
    const section = body.join("\n").trim();
    body = [];
    if (!section) return;
    const heading = headingStack.filter(Boolean).join(" > ") || "General instructions";
    const paragraphs = section.split(/\n\s*\n/);
    let buffer = "";

    function push(text) {
      const clean = text.trim();
      if (clean) chunks.push({
        id: chunks.length,
        heading,
        text: clean,
        searchText: (heading + "\n" + clean).toLowerCase()
      });
    }

    for (const paragraph of paragraphs) {
      const p = paragraph.trim();
      if (!p) continue;
      if (p.length > 1800) {
        if (buffer) { push(buffer); buffer = ""; }
        for (let i = 0; i < p.length; i += 1500) {
          push(p.slice(Math.max(0, i - (i ? 120 : 0)), i + 1500));
        }
      } else if (buffer && (buffer.length + p.length + 2 > 1500)) {
        push(buffer);
        buffer = p;
      } else {
        buffer += (buffer ? "\n\n" : "") + p;
      }
    }
    if (buffer) push(buffer);
  }

  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      flush();
      const level = match[1].length;
      headingStack = headingStack.slice(0, level - 1);
      headingStack[level - 1] = match[2].trim();
    } else {
      body.push(line);
    }
  }
  flush();

  if (!chunks.length) {
    for (let i = 0; i < source.length; i += 1500) {
      const text = source.slice(Math.max(0, i - (i ? 120 : 0)), i + 1500);
      chunks.push({ id: chunks.length, heading: "Skill content", text, searchText: text.toLowerCase() });
    }
  }
  return chunks;
}

function skillTerms(text) {
  const stop = new Set(["the","and","for","with","that","this","from","into","your","you","are","was","were","what","when","where","which","how","can","could","would","should","please","about","have","has","had","then","than","them","they","their","there","will","just","make","give","want","need"]);
  return (String(text).toLowerCase().match(/[a-z0-9][a-z0-9_+#.-]{1,}/g) || []).filter(x => !stop.has(x));
}

function retrieveRelevantSkill(query, maxChars = 3000) {
  if (!skillChunks.length) return "No SKILL.md has been loaded.";
  const terms = [...new Set(skillTerms(query))];
  const n = skillChunks.length;
  const avgLength = skillChunks.reduce((s, c) => s + skillTerms(c.text).length, 0) / Math.max(1, n);

  const ranked = skillChunks.map((chunk, index) => {
    const tokens = skillTerms(chunk.text);
    const tfMap = new Map();
    tokens.forEach(t => tfMap.set(t, (tfMap.get(t) || 0) + 1));
    let score = 0;

    for (const term of terms) {
      const tf = tfMap.get(term) || 0;
      if (!tf) continue;
      const df = skillChunks.reduce((count, c) => count + (c.searchText.includes(term) ? 1 : 0), 0);
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += idf * (tf * 2.2) / (tf + 1.2 * (0.28 + 0.72 * tokens.length / Math.max(1, avgLength)));
      if (chunk.heading.toLowerCase().includes(term)) score += 1.5;
    }
    if (index === 0) score += 0.4;
    return { ...chunk, score };
  }).sort((a, b) => b.score - a.score);

  const chosen = [];
  let used = 0;
  if (skillChunks[0].text.length < maxChars) {
    chosen.push(skillChunks[0]);
    used += skillChunks[0].text.length;
  }

  for (const item of ranked) {
    if (chosen.some(x => x.id === item.id)) continue;
    const cost = item.text.length + item.heading.length + 30;
    if (used + cost > maxChars) continue;
    chosen.push(item);
    used += cost;
  }

  chosen.sort((a, b) => a.id - b.id);
  window.__uiSkillRetrieval = {
    selected: chosen.length,
    total: skillChunks.length,
    headings: [...new Set(chosen.map(x => x.heading))]
  };

  return chosen.map(x => `### ${x.heading}\n${x.text}`).join("\n\n---\n\n")
    || skillChunks[0].text.slice(0, maxChars);
}

function getContextProfile() {
  return {
    skillChars: 450,
    historyChars: 250,
    maxHistoryMessages: 2,
    outputTokens: 300
  };
}

function buildRecentHistory(messages, maxChars, maxMessages) {
  const result = [];
  let used = 0;

  for (const message of [...messages].reverse()) {
    if (!["user", "assistant"].includes(message.role)) continue;

    const content = String(message.content || "").slice(-180);
    if (used + content.length > maxChars) break;

    result.unshift({ role: message.role, content });
    used += content.length;

    if (result.length >= maxMessages) break;
  }

  return result;
}

// ---------------- LOCAL AGENT TOOLKIT ----------------
const LOCAL_TOOL_CATALOG = [
  {name:"calculator",description:"Evaluate a mathematical expression. Supports + - * / % ^, parentheses, pi, e, sqrt, abs, sin, cos, tan, log, ln, min, max and round.",parameters:{expression:"string"}},
  {name:"convert_units",description:"Convert common length, mass, temperature, time, data-size and volume units.",parameters:{value:"number",from:"string",to:"string"}},
  {name:"current_datetime",description:"Get the browser's current local date, time and timezone."},
  {name:"format_json",description:"Parse and pretty-print JSON, or report the parse error.",parameters:{json:"string"}},
  {name:"text_stats",description:"Count words, characters, lines and estimate reading time for supplied text.",parameters:{text:"string"}},
  {name:"search_knowledge",description:"Search the locally stored full SKILL.md and saved project notes for relevant passages.",parameters:{query:"string"}},
  {name:"list_projects",description:"List saved local projects and their notes."},
  {name:"save_project",description:"Save or update a project in local IndexedDB. User confirmation is required.",parameters:{name:"string",notes:"string"}},
  {name:"github_list_files",description:"List files in the connected GitHub repository. Requires an already connected private repository.",parameters:{path:"string (optional; default empty)"}},
  {name:"github_read_file",description:"Read a text file from the connected GitHub repository. Requires an already connected private repository.",parameters:{path:"string"}}
];

function tokenizeMath(expr) {
  const s = String(expr).replace(/\s+/g, "");
  const tokens = s.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[a-zA-Z]+|[()+\-*/%^,]/g);
  if (!tokens || tokens.join("") !== s) throw new Error("Unsupported character or invalid expression.");
  return tokens;
}

function calculateSafe(expression) {
  const t = tokenizeMath(expression);
  let i = 0;
  const peek = () => t[i];
  const take = () => t[i++];

  function primary() {
    const x = take();
    if (x === undefined) throw new Error("Unexpected end of expression.");
    if (x === "+") return unary();
    if (x === "-") return -unary();
    if (x === "(") {
      const v = add();
      if (take() !== ")") throw new Error("Missing closing parenthesis.");
      return v;
    }
    if (/^(?:\d|\.)/.test(x)) return Number(x);
    if (/^[a-z]+$/i.test(x)) {
      const name = x.toLowerCase();
      if (name === "pi") return Math.PI;
      if (name === "e") return Math.E;
      if (take() !== "(") throw new Error("Unknown constant or function: " + name);
      const args = [];
      if (peek() !== ")") {
        args.push(add());
        while (peek() === ",") { take(); args.push(add()); }
      }
      if (take() !== ")") throw new Error("Missing ) after function arguments.");
      const f = {sqrt:Math.sqrt,abs:Math.abs,sin:Math.sin,cos:Math.cos,tan:Math.tan,log:Math.log10,ln:Math.log,round:Math.round,floor:Math.floor,ceil:Math.ceil,min:Math.min,max:Math.max,pow:Math.pow};
      if (!f[name]) throw new Error("Function not allowed: " + name);
      return f[name](...args);
    }
    throw new Error("Unexpected token: " + x);
  }

  function power() { let a = primary(); if (peek() === "^") { take(); a = Math.pow(a, unary()); } return a; }
  function unary() { if (peek() === "+") { take(); return unary(); } if (peek() === "-") { take(); return -unary(); } return power(); }
  function mul() { let a = unary(); while (["*","/","%"].includes(peek())) { const op = take(), b = unary(); a = op === "*" ? a*b : op === "/" ? a/b : a%b; } return a; }
  function add() { let a = mul(); while (peek() === "+" || peek() === "-") { const op = take(), b = mul(); a = op === "+" ? a+b : a-b; } return a; }

  const value = add();
  if (i < t.length) throw new Error("Unexpected token: " + peek());
  if (!Number.isFinite(value)) throw new Error("Result is not a finite number.");
  return value;
}
const UNIT_TABLE = {
  length:{m:1,km:1000,cm:.01,mm:.001,mi:1609.344,ft:.3048,in:.0254,yd:.9144},
  mass:{kg:1,g:.001,mg:.000001,lb:.45359237,oz:.028349523125},
  time:{s:1,sec:1,min:60,hr:3600,h:3600,day:86400},
  data:{b:1,byte:8,kb:8000,mb:8000000,gb:8000000000,kib:8192,mib:8388608,gib:8589934592},
  volume:{l:1,ml:.001,m3:1000,gal:3.785411784,cup:.2365882365}
};

function convertUnits(value,from,to) {
  const a=String(from).toLowerCase(),b=String(to).toLowerCase(),v=Number(value);
  if(!Number.isFinite(v))throw new Error("Value must be a finite number.");
  if(["c","°c","celsius","f","°f","fahrenheit","k","kelvin"].includes(a)&&["c","°c","celsius","f","°f","fahrenheit","k","kelvin"].includes(b)){
    let c=(a==="f"||a==="°f"||a==="fahrenheit")?(v-32)*5/9:(a==="k"||a==="kelvin")?v-273.15:v;
    return (b==="f"||b==="°f"||b==="fahrenheit")?c*9/5+32:(b==="k"||b==="kelvin")?c+273.15:c;
  }
  for(const group of Object.values(UNIT_TABLE))if(a in group&&b in group)return v*group[a]/group[b];
  throw new Error(`Unsupported or incompatible units: ${from} → ${to}.`);
}

async function runLocalTool(name,args={}) {
  switch(name){
    case "calculator":
      return {result:calculateSafe(args.expression)};
    case "convert_units":
      return {result:convertUnits(args.value,args.from,args.to),from:args.from,to:args.to};
    case "current_datetime":{
      const d=new Date();
      return {local:d.toString(),iso:d.toISOString(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone};
    }
    case "format_json":{
      const value=JSON.parse(args.json);
      return {valid:true,formatted:JSON.stringify(value,null,2)};
    }
    case "text_stats":{
      const text=String(args.text||"");
      const words=(text.trim().match(/\S+/g)||[]).length;
      return {
        characters:text.length,
        charactersWithoutSpaces:text.replace(/\s/g,"").length,
        words,
        lines:text?text.split(/\r?\n/).length:0,
        estimatedReadingMinutes:Math.max(1,Math.ceil(words/220))
      };
    }
    case "search_knowledge":{
      const q=String(args.query||"");
      const skill=retrieveRelevantSkill(q,5000);
      const projects=await db.getAll("projects");
      const terms=skillTerms(q);
      const matches=projects.map(p=>({
        name:p.name,
        notes:p.notes||"",
        score:terms.reduce((n,w)=>n+((p.name+" "+p.notes).toLowerCase().includes(w)?1:0),0)
      })).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,5);
      return {skillPassages:skill,matchingProjects:matches};
    }
    case "list_projects":
      return await db.getAll("projects");
    case "save_project":{
      const name=String(args.name||"").trim(),notes=String(args.notes||"");
      if(!name)throw new Error("Project name is required.");
      if(!confirm(`Allow UNIVERSAL INTELLIGENCE to save/update this local project?\n\n${name}\n\nThis writes to this browser's IndexedDB only.`))
        return {saved:false,reason:"User declined."};
      const all=await db.getAll("projects");
      const old=all.find(p=>p.name.toLowerCase()===name.toLowerCase());
      await db.put("projects",{id:old?.id||uid(),name,notes,updatedAt:new Date().toISOString()});
      return {saved:true,name,storage:"This browser only"};
    }
    case "github_list_files":{
      if(!connectedRepo||!githubToken)throw new Error("Connect and authorize your private GitHub repository first.");
      const path=String(args.path||"").replace(/^\/+|\/+$/g,"");
      const url=`/repos/${connectedRepo.owner}/${connectedRepo.repo}/contents/${path}`;
      const result=await githubRequest(url);
      return Array.isArray(result)
        ?result.map(x=>({name:x.name,path:x.path,type:x.type,size:x.size}))
        :({name:result.name,path:result.path,type:result.type});
    }
    case "github_read_file":{
      if(!connectedRepo||!githubToken)throw new Error("Connect and authorize your private GitHub repository first.");
      const path=String(args.path||"").replace(/^\/+/,"");
      if(!path)throw new Error("File path is required.");
      const result=await githubRequest(`/repos/${connectedRepo.owner}/${connectedRepo.repo}/contents/${path}`);
      if(result.type!=="file"||!result.content)throw new Error("The requested path is not a readable text file.");
      return {path:result.path,content:decodeURIComponent(escape(atob(result.content.replace(/\n/g,""))))};
    }
    default:
      throw new Error("Tool not found: "+name);
  }
}

function parseAgentToolCall(content) {
  const match=String(content).match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
  if(!match)return null;
  try {
    return {
      call:JSON.parse(match[1]),
      before:String(content).slice(0,match.index).trim()
    };
  } catch(e) {
    throw new Error("The model produced malformed tool-call JSON: "+e.message);
  }
}

function agentToolInstructions() {
  return `

LOCAL TOOL EXECUTION PROTOCOL:
You may use the following tools when they materially help. To call exactly one tool, output ONLY this format and no surrounding prose:
<tool_call>{"name":"tool_name","arguments":{}}</tool_call>
Available tools:
${LOCAL_TOOL_CATALOG.map(t=>`- ${t.name}: ${t.description}`).join("\n")}
Tool arguments must be valid JSON. Never invent tool results. After a tool result is supplied, continue the task; you may call another tool if needed. Maximum 4 tool calls per user request. GitHub tools are read-only. save_project asks the user for confirmation. Never claim browser access beyond these tools. If no tool is needed, answer normally.`;
}

function buildAgentSystemPrompt(relevantSkill) {
  return `You are UNIVERSAL INTELLIGENCE, a high-capability local AI agent for advanced engineering, research, reasoning, planning, writing and productivity.

QUALITY STANDARD:
- Work at the highest level supported by the actual model and available runtime.
- For complex tasks, identify objectives and constraints, plan the work, solve systematically, and verify the result.
- Prefer complete, robust, maintainable implementations over superficial examples.
- Preserve existing features and user requirements when changing code.
- Be explicit about assumptions, limitations and uncertainty.
- Never fabricate tools, tests, files, sources, execution, or completed actions.
- Do not claim web access, arbitrary local-file access, shell execution, or repository write access unless a real capability performs it.
- Protect secrets. Ask before destructive or external actions.
- Do not reveal hidden chain-of-thought; provide useful plans, concise reasoning summaries and verification.

SKILL POLICY:
The user's complete original SKILL.md remains stored unchanged in IndexedDB. The passages below are retrieved from that full file for this task. Follow applicable passages. Omitted passages are not deleted; if a question depends on a passage not supplied, say so rather than inventing its contents.

--- TASK-RELEVANT SKILL.MD PASSAGES ---
${relevantSkill}${agentToolInstructions()}`;
}

const titles = {
  chat:["YOUR PRIVATE WORKSPACE","Assistant"],
  projects:["LOCAL KNOWLEDGE STORE","Projects & memory"],
  sync:["CONTROLLED REPOSITORY ACCESS","GitHub sync"],
  settings:["AGENT CONFIGURATION","Settings"]
};

async function initDB() {
  const nativeDB = await new Promise((resolve,reject)=>{
    const request=indexedDB.open(DB_NAME,DB_VERSION);
    request.onupgradeneeded=()=>{
      const database=request.result;
      if(!database.objectStoreNames.contains("conversations"))database.createObjectStore("conversations",{keyPath:"id"});
      if(!database.objectStoreNames.contains("projects"))database.createObjectStore("projects",{keyPath:"id"});
      if(!database.objectStoreNames.contains("meta"))database.createObjectStore("meta");
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
  const request=(store,method,...args)=>new Promise((resolve,reject)=>{
    const tx=nativeDB.transaction(store,method==="get"||method==="getAll"?"readonly":"readwrite");
    const req=tx.objectStore(store)[method](...args);
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
  db={
    get:(s,k)=>request(s,"get",k),
    getAll:s=>request(s,"getAll"),
    put:(s,v,k)=>request(s,"put",v,...(k===undefined?[]:[k])),
    clear:s=>request(s,"clear")
  };
}

const uid=()=>crypto.randomUUID();

async function loadSkill() {
  skillText=await db.get("meta","skillText")||"";
  skillChunks=buildSkillChunks(skillText);
  $("skillState").textContent=skillText
    ?`Loaded private SKILL.md · ${skillText.length.toLocaleString()} characters`
    :"No skill loaded. Upload your private SKILL.md here; it will stay in this browser until you approve a GitHub backup.";
}

$("skillUpload").addEventListener("change",async(e)=>{
  const file=e.target.files?.[0];
  if(!file)return;
  if(file.size>1024*1024){
    alert("For safety, the skill file must be under 1 MB.");
    e.target.value="";
    return;
  }
  skillText=await file.text();
  await db.put("meta",skillText,"skillText");
  skillChunks=buildSkillChunks(skillText);
  $("skillState").textContent=`Loaded private SKILL.md · ${skillText.length.toLocaleString()} characters`;
  capabilityStatus();
});

function showPanel(name) {
  document.querySelectorAll(".panel").forEach(p=>p.classList.remove("active"));
  $("panel-"+name).classList.add("active");
  document.querySelectorAll(".nav").forEach(n=>n.classList.toggle("active",n.dataset.panel===name));
  $("sectionEyebrow").textContent=titles[name][0];
  $("sectionTitle").textContent=titles[name][1];
  if(name==="projects")renderProjects();
  if(name==="sync")renderSyncPreview();
}

document.querySelectorAll(".nav").forEach(n=>n.addEventListener("click",()=>showPanel(n.dataset.panel)));
$("newChat").onclick=()=>{
  activeConversation=[];
  $("messages").innerHTML="";
  $("welcome").classList.remove("hidden");
  showPanel("chat");
};
document.querySelectorAll(".suggestion").forEach(b=>b.onclick=()=>{
  $("promptInput").value=b.dataset.prompt;
  $("promptInput").focus();
});
$("promptInput").addEventListener("input",()=>{
  $("sendButton").disabled=!$("promptInput").value.trim()||!engine;
  $("promptInput").style.height="auto";
  $("promptInput").style.height=Math.min($("promptInput").scrollHeight,160)+"px";
});
$("promptInput").addEventListener("keydown",e=>{
  if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendMessage();}
});
$("sendButton").onclick=sendMessage;
$("modelButton").onclick=()=>showPanel("settings");
$("modelSelect").onchange=e=>selectedModel=e.target.value;

function addMessage(role,text) {
  $("welcome").classList.add("hidden");
  const wrap=document.createElement("div");
  wrap.className="message "+role;
  const av=document.createElement("div");
  av.className="avatar";
  av.textContent=role==="user"?"YOU":"✳";
  const bubble=document.createElement("div");
  bubble.className="bubble";
  bubble.textContent=text;
  wrap.append(av,bubble);
  $("messages").append(wrap);
  $("messages").scrollTop=$("messages").scrollHeight;
  return bubble;
}
async function loadModel(){
  if(engine)return;
  if(!("gpu" in navigator)){
    setModelStatus("WebGPU is not available in this browser. Try a recent Chrome or Edge version on supported hardware.");
    return;
  }
  $("loadModel").disabled=true;
  $("modelProgress").classList.remove("hidden");
  setModelStatus("Loading model library and downloading model…");
  try{
    const webllm=await import("https://esm.sh/@mlc-ai/web-llm");
    engine=await webllm.CreateMLCEngine(selectedModel,{
      initProgressCallback:(p)=>{
        const pct=Math.round((p.progress||0)*100);
        $("progressBar").style.width=pct+"%";
        $("progressPct").textContent=pct+"%";
        $("progressText").textContent=p.text||"Preparing model…";
      }
    });
    $("runtimeDot").classList.add("green");
    $("runtimeStatus").textContent="AI engine ready";
    $("modelBadge").textContent=selectedModel.split("-").slice(0,2).join(" ");
    setModelStatus("Model loaded and running in this browser.");
    $("sendButton").disabled=!$("promptInput").value.trim();
  }catch(e){
    setModelStatus("Model failed to load: "+e.message);
    engine=null;
  }finally{
    $("loadModel").disabled=false;
  }
}

function setModelStatus(s){
  $("modelStatus").textContent=s;
  $("progressText").textContent=s;
}
$("loadModel").onclick=loadModel;

let isGenerating=false;

async function sendMessage() {
  const prompt = $("promptInput").value.trim();

  if (!prompt || !engine || isGenerating) return;

  $("promptInput").value = "";
  $("sendButton").disabled = true;
  isGenerating = true;

  // Limit an exceptionally long individual request.
  const safePrompt = prompt.slice(0, 1600);

  activeConversation.push({
    role: "user",
    content: safePrompt
  });

  addMessage("user", prompt);

  const reply = addMessage("assistant", "Working on your task…");

  try {
    const profile = getContextProfile();

    // Retrieve only a small relevant extract.
    // The original full SKILL.md stays untouched in IndexedDB.
    const relevantSkill = retrieveRelevantSkill(
      safePrompt,
      profile.skillChars
    );

    const history = buildRecentHistory(
      activeConversation.slice(0, -1),
      profile.historyChars,
      profile.maxHistoryMessages
    );

    let messages = [
      {
        role: "system",
        content: buildAgentSystemPrompt(relevantSkill)
      },
      ...history,
      {
        role: "user",
        content: safePrompt
      }
    ];

    let answer = "";
    let toolCount = 0;

    while (toolCount < 4) {
      // Apply the budget before EVERY model generation,
      // including after local tool execution.
      const safeMessages = fitMessagesToSafeBudget(messages);

      const result = await engine.chat.completions.create({
        messages: safeMessages,
        temperature: 0.4,
        max_tokens: profile.outputTokens
      });

      const content =
        result.choices?.[0]?.message?.content || "";

      const parsed = parseAgentToolCall(content);

      if (!parsed) {
        answer = content || "The model returned an empty response.";
        break;
      }

      const call = parsed.call;

      if (
        !call ||
        typeof call.name !== "string" ||
        !call.arguments ||
        typeof call.arguments !== "object"
      ) {
        throw new Error("Invalid tool-call format.");
      }

      reply.textContent =
        `Running local tool: ${call.name} (${toolCount + 1}/4)…`;

      let toolResult;

      try {
        toolResult = await runLocalTool(
          call.name,
          call.arguments
        );
      } catch (error) {
        toolResult = { error: error.message };
      }

      // Prevent large tool outputs from overflowing context.
      const resultText = JSON.stringify(toolResult).slice(0, 800);

      messages.push({
        role: "assistant",
        content
      });

      messages.push({
        role: "user",
        content:
          "Tool result for " + call.name + ":\n" +
          resultText +
          "\nContinue the task using this result."
      });

      toolCount++;
    }

    if (!answer) {
      answer = "I reached the four-tool execution limit. Please ask me to continue.";
    }

    reply.textContent = answer;

    activeConversation.push({
      role: "assistant",
      content: answer
    });

    await saveConversation();

  } catch (error) {
    reply.textContent =
      "Generation error: " + error.message;
  } finally {
    isGenerating = false;

    $("sendButton").disabled =
      !$("promptInput").value.trim() || !engine;
  }
}
function fitMessagesToSafeBudget(messages) {
  const MAX_TOTAL_CHARS = 4800;
  const SYSTEM_CHARS = 3300;
  const LAST_MESSAGE_CHARS = 1000;

  if (!messages.length) return messages;

  const system = {
    role: "system",
    content: String(messages[0].content || "").slice(0, SYSTEM_CHARS)
  };

  const last = messages[messages.length - 1];
  const finalMessage = {
    role: last.role,
    content: String(last.content || "").slice(-LAST_MESSAGE_CHARS)
  };

  const middle = [];
  let used = system.content.length + finalMessage.content.length;

  for (const message of messages.slice(1, -1).reverse()) {
    const content = String(message.content || "").slice(-150);
    const cost = content.length + 20;

    if (used + cost > MAX_TOTAL_CHARS) break;

    middle.unshift({
      role: message.role,
      content
    });

    used += cost;
  }

  return [system, ...middle, finalMessage];
}

async function saveConversation(){
  if(!activeConversation.length)return;
  const item={
    id:"current",
    updatedAt:new Date().toISOString(),
    messages:activeConversation
  };
  await db.put("conversations",item);
}

async function renderProjects(){
  const items=await db.getAll("projects");
  const host=$("projectList");
  host.innerHTML="";

  if(!items.length){
    host.innerHTML='<div class="empty">No projects yet. Create a project to save durable context.</div>';
    return;
  }

  items.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).forEach(p=>{
    const el=document.createElement("div");
    el.className="project";

    const h=document.createElement("h3");
    h.textContent=p.name;

    const d=document.createElement("p");
    d.textContent=p.notes||"No notes yet.";

    const meta=document.createElement("div");
    meta.className="tiny";
    meta.textContent="Updated "+new Date(p.updatedAt).toLocaleString();

    const edit=document.createElement("button");
    edit.className="secondary";
    edit.textContent="Edit";
    edit.onclick=()=>editProject(p);

    el.append(h,d,meta,edit);
    host.append(el);
  });
}

function editProject(existing=null){
  const name=prompt("Project name",existing?.name||"");
  if(name===null||!name.trim())return;

  const notes=prompt("Project notes / reusable context",existing?.notes||"");
  if(notes===null)return;

  db.put("projects",{
    id:existing?.id||uid(),
    name:name.trim(),
    notes,
    updatedAt:new Date().toISOString()
  }).then(renderProjects);
}
$("addProject").onclick=()=>editProject();

function exportPayload(){
  return {
    format:"universal-intelligence-backup-v1",
    exportedAt:new Date().toISOString(),
    skill:skillText,
    conversations:[],
    projects:[]
  };
}

async function buildBackup(){
  const payload=exportPayload();
  payload.conversations=await db.getAll("conversations");
  payload.projects=await db.getAll("projects");
  return payload;
}

$("exportData").onclick=async()=>{
  const data=await buildBackup();
  download("universal-intelligence-backup.json",JSON.stringify(data,null,2),"application/json");
};

function download(name,content,type){
  const blob=new Blob([content],{type});
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download=name;
  a.click();
  URL.revokeObjectURL(a.href);
}

$("clearData").onclick=async()=>{
  if(!confirm("Permanently delete all conversations and projects stored by this app in this browser? Export a backup first. This cannot be undone."))return;
  await db.clear("conversations");
  await db.clear("projects");
  activeConversation=[];
  $("messages").innerHTML="";
  $("welcome").classList.remove("hidden");
  renderProjects();
  alert("Local app data cleared.");
};

async function githubRequest(path,options={}){
  const response=await fetch("https://api.github.com"+path,{
    ...options,
    headers:{
      Accept:"application/vnd.github+json",
      Authorization:"Bearer "+githubToken,
      "X-GitHub-Api-Version":"2022-11-28",
      ...(options.headers||{})
    }
  });
  const body=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(body.message||"GitHub API error "+response.status);
  return body;
}

$("connectGithub").onclick=async()=>{
  const token=$("githubToken").value.trim();
  const owner=$("repoOwner").value.trim();
  const repo=$("repoName").value.trim();

  if(!token||!owner||!repo){
    $("githubStatus").textContent="Enter token, owner and repository.";
    return;
  }

  githubToken=token;
  $("githubStatus").textContent="Checking repository permissions…";

  try{
    const r=await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
    if(!r.private)throw new Error("This repository is public. Choose a private repository.");

    connectedRepo={owner,repo,branch:r.default_branch};
    $("githubStatus").textContent=`Connected: ${owner}/${repo} · private · branch ${r.default_branch}. Token held in memory only.`;
    $("githubToken").value="";
    renderSyncPreview();
  }catch(e){
    githubToken="";
    connectedRepo=null;
    $("githubStatus").textContent="Connection failed: "+e.message;
  }
};

async function renderSyncPreview(){
  if(!connectedRepo){
    $("syncPreview").textContent="Connect a repository to prepare a backup preview.";
    return;
  }

  const backup=await buildBackup();
  proposedFiles=[{
    path:"backups/browser-backup.json",
    content:JSON.stringify(backup,null,2)
  }];

  if(skillText)proposedFiles.push({path:"SKILL.md",content:skillText});

  $("syncPreview").innerHTML="";
  proposedFiles.forEach(f=>{
    const row=document.createElement("div");
    row.className="preview-row";

    const a=document.createElement("span");
    a.textContent=f.path;

    const b=document.createElement("span");
    b.textContent=(new Blob([f.content]).size/1024).toFixed(1)+" KB";

    row.append(a,b);
    $("syncPreview").append(row);
  });

  $("approveSync").disabled=false;
}

$("disconnectGithub").onclick=()=>{
  githubToken="";
  connectedRepo=null;
  proposedFiles=[];
  $("githubToken").value="";
  $("githubStatus").textContent="Disconnected. Token cleared from app memory.";
  $("approveSync").disabled=true;
  renderSyncPreview();
};

$("approveSync").onclick=async()=>{
  if(!connectedRepo||!githubToken)return;

  const summary=proposedFiles.map(f=>f.path).join("\n");

  if(!confirm(
    "APPROVE UPLOAD to "+connectedRepo.owner+"/"+connectedRepo.repo+
    "?\n\nFiles:\n"+summary+
    "\n\nThis will create or update these files in your private repository."
  ))return;

  $("approveSync").disabled=true;

  try{
    for(const file of proposedFiles){
      const base=`/repos/${connectedRepo.owner}/${connectedRepo.repo}/contents/${file.path}`;
      let sha;

      try{
        const old=await githubRequest(base);
        sha=old.sha;
      }catch(e){
        if(!String(e.message).includes("Not Found"))throw e;
      }

      await githubRequest(base,{
        method:"PUT",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          message:"Approved Universal Intelligence backup: "+file.path,
          content:btoa(unescape(encodeURIComponent(file.content))),
          branch:connectedRepo.branch,
          ...(sha?{sha}:{})
        })
      });
    }

    $("githubStatus").textContent="Approved backup uploaded successfully. Revoke your GitHub token when finished.";
    alert("Approved files uploaded to your private repository.");
  }catch(e){
    $("githubStatus").textContent="Upload stopped: "+e.message+" Check repository contents before retrying.";
  }finally{
    $("approveSync").disabled=false;
  }
};

$("viewSkill").onclick=()=>openModal("Bundled SKILL.md",skillText||"SKILL.md unavailable.");

function openModal(title,body){
  $("modalTitle").textContent=title;
  $("modalBody").textContent=body;
  $("modal").showModal();
}
$("closeModal").onclick=()=>$("modal").close();

function capabilityStatus(){
  const rows=[
    ["Browser WebGPU",!!navigator.gpu],
    ["IndexedDB",!!window.indexedDB],
    ["Local tool execution",true],
    ["Local knowledge retrieval",!!skillChunks.length],
    ["GitHub API","Read-only agent tools when connected; backup writes require approval"],
    ["Bundled SKILL.md",!!skillText],
    ["Local model",!!engine],
    ["Server-side execution",false],
    ["External AI API",false]
  ];

  $("capabilityList").innerHTML="";
  rows.forEach(([k,v])=>{
    const d=document.createElement("div");
    d.className="capability";
    const b=document.createElement("b");
    b.textContent=typeof v==="boolean"?(v?"Available":"Not provided"):v;
    d.append(k+" · ",b);
    $("capabilityList").append(d);
  });
}

await initDB();
await loadSkill();

const savedConversation=await db.get("conversations","current");
if(savedConversation?.messages?.length){
  activeConversation=savedConversation.messages;
  $("welcome").classList.add("hidden");
  activeConversation.forEach(m=>addMessage(m.role,m.content));
}

capabilityStatus();

if(!navigator.gpu){
  $("runtimeStatus").textContent="WebGPU unavailable";
  $("runtimeDot").classList.remove("green");
}

if("serviceWorker" in navigator&&location.protocol.startsWith("http")){
  navigator.serviceWorker.register("./sw.js").catch(()=>{});
}