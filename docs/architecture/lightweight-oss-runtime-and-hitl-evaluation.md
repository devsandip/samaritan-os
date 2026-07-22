# Samaritan Architecture Analysis: Evaluating Agent Runtimes and HITL Infrastructure for Local-First OS

## 1. Executive Summary

The following analysis evaluates the 2026 landscape of off-the-shelf agent runtimes and Human-in-the-Loop (HITL) infrastructure against the strict constraints of a personal, local-first, single-user agentic OS running on macOS. The assessment filters candidates through requirements for a low operational footprint, zero cost, and genuine Open Source Initiative (OSI) licensing, while isolating the differentiated value of the "Samaritan" Action Center.

- **The Buy/Build Verdict**: The undifferentiated plumbing of agent execution—cron scheduling, durable execution, secret management, and process isolation—is highly commoditized and should be adopted immediately. Conversely, the differentiated Action Center logic—specifically the policy engine, autonomy gradients, typed rendering, and structural execution locks—remains stark whitespace in the open-source ecosystem and must be custom-built.

- **The Local-First Runtime Winner**: OpenClaw emerges as the definitive choice for the runtime layer. Its architecture is explicitly designed as a personal, local-first daemon for macOS, handling channels, skills, cron scheduling, and memory without requiring external message brokers or cloud orchestration<sup>1</sup>.

- **The Orchestration Alternative**: For a purist code-first approach, Mastra (Apache 2.0 core) provides a lightweight TypeScript workflow engine with native .suspend() primitives, operating without the heavy footprint of Temporal or LangGraph Platform, though it carries enterprise licensing traps for its UI components<sup>4</sup>.

- **The HITL Surface Reality**: Off-the-shelf HITL tools uniformly treat human intervention as a binary, generic allow/deny operation or an unstructured chat response. None possess the typed, schema-rendered, policy-gated infrastructure required by Samaritan<sup>7</sup>.

- **Inbox Scaffolding Strategy**: LangGraph Agent Inbox (MIT) and AG-UI (CopilotKit) provide the best unopinionated UI primitives for rendering interactive states, but they act strictly as dumb presentation layers over custom state machines<sup>9</sup>. They should be utilized as frontend references rather than full adoption targets.

- **Full-Stack Replacements**: There is no single lightweight, OSS full-stack tool that replaces the Samaritan v0 architecture wholesale. Frameworks like Activepieces (fair-code) offer node-based HITL, but enforce visual programming over code-first deterministic policy<sup>12</sup>.

- **The Autonomy Gradient Gap**: Market solutions optimize for enterprise Role-Based Access Control (RBAC) and SLA routing. The concept of "earn-autonomy"—where an agent reduces its blast radius dynamically based on a user's historical approval patterns—is entirely absent from the open-source ecosystem<sup>8</sup>.

- **Audit Substrate Deficiencies**: While enterprise tools like Camunda possess rigorous audit logs, lightweight tools discard historical state transitions. Implementing append-only cryptographic or SQLite-based audit trails remains a mandatory custom build, heavily mirroring patterns seen in compliance frameworks like PWOS Core<sup>13</sup>.

- **Licensing Traps (2026)**: The landscape is rife with open-core bait-and-switch tactics. Mastra reserves its Agent Builder for Enterprise Edition (EE)<sup>6</sup>; n8n relies on fair-code licenses<sup>12</sup>; and HumanLayer routes through hosted cloud infrastructure for advanced features<sup>16</sup>.

- **Architectural Recommendation**: Discard the hand-built Samaritan v0 runtime. Adopt the OpenClaw gateway daemon to handle macOS-native execution, Model Context Protocol (MCP) integrations, and scheduling. Rebuild the custom Action Center logic as a lightweight SQLite and React application, utilizing AG-UI concepts solely for the frontend rendering protocol.

## 2. Category 1: Agent Runtime Inventory

The runtime layer is responsible for durable execution, event and schedule triggering, secret management, and keeping agents alive on a frequently sleeping macOS environment. The evaluation prioritizes tools that operate as a single process or small container, explicitly discarding enterprise clusters requiring JVM stacks, heavy message brokers, or Kubernetes.

### Comparison Table: Agent Runtimes

| **Tool** | **Scheduling & Execution Model** | **License** | **Cost Model** | **Footprint & Complexity** | **Constraint Fit** |
|----|----|----|----|----|----|
| **OpenClaw** | Cron, Event-driven daemon | OSS (Apache/MIT) | Free, self-host | 1 Node process (launchd) | Ideal |
| **Letta** | Stateful memory, Crons | OSS (Apache 2.0) | Free, self-host | 1 Docker / CLI | High |
| **Mastra (Core)** | Graph/Workflow engine | OSS (Apache 2.0) | Free, self-host | 1 TS process/server | High |
| **LangGraph** | Graph state machine | OSS (MIT) | Free, self-host | Python/TS process | High |
| **LlamaIndex** | Event-driven workflows | OSS (MIT) | Free, self-host | Python process | Medium |
| **CrewAI** | Multi-agent sequential | OSS (MIT) | Free, self-host | Python process | Medium |
| **AutoGen** | Multi-agent conversational | OSS (MIT) | Free, self-host | Python process | Medium |
| **Restate** | Durable event sourcing | OSS (MIT/Apache) | Free, self-host | 1 Go server + app | Medium |
| **Inngest** | Step-function durability | Source-available | Cloud/Self-host | Heavy (Requires Redis/DB) | Low |
| **Trigger.dev** | Durable background jobs | OSS (MIT) | Cloud/Self-host | Heavy (Docker + PG) | Low |
| **Windmill** | Script orchestration | OSS (AGPL v3) | Cloud/Self-host | Heavy (Rust + PG + Workers) | Low |
| **n8n** | Visual workflow engine | Fair-code | Freemium/Open-core | Heavy (Docker + PG) | Low |
| **Activepieces** | Visual flow engine | Fair-code/MIT | Freemium/Open-core | Heavy (Docker + PG + Redis) | Low |
| **Dify** | LLM app orchestration | OSS (Apache 2.0) | Cloud/Self-host | Heavy (Docker Compose) | Low |
| **Flowise** | Visual LangChain builder | OSS (Apache 2.0) | Free, self-host | Medium (Node server) | Low |
| **Kestra** | Data orchestration | OSS (Apache 2.0) | Cloud/Self-host | Massive (JVM + Elastic) | Reject |
| **Prefect** | Data flow orchestration | OSS (Apache 2.0) | Cloud/Self-host | Heavy (Python + DB) | Reject |
| **Temporal** | Universal durability | OSS (MIT) | Cloud/Self-host | Massive (Cassandra/PG + Go) | Reject |
| **Claude SDK** | Client-side scripting | OSS (MIT) | Usage-billed API | Zero (Client only) | Reject |
| **CF Agents** | Edge Durable Objects | Proprietary | Usage-billed | Zero (Serverless) | Reject |
| **Anthropic** | Managed hosted runtime | Proprietary | Usage-billed | Zero (Hosted) | Reject |

### Deep Dive Analysis

#### The Local-First Daemons: OpenClaw

OpenClaw represents the zenith of the personal, local-first agent paradigm. Unlike cloud-native orchestrators, its architecture is explicitly designed as a "Personal AI Assistant" that installs via a single CLI command (openclaw onboard --install-daemon) and registers as a launchd user service on macOS<sup>1</sup>. This satisfies the critical requirement of surviving laptop sleep cycles and reboots without requiring Kubernetes or Docker. It is highly distributable, relying on local Node.js environments. OpenClaw natively supports cron scheduling, Model Context Protocol (MCP) skills, and local memory via SQLite workspaces<sup>1</sup>. Crucially for Samaritan's privacy constraints, it operates on the local file system—vital for reading Obsidian vaults and developer journals—and handles its own webhook ingest for external events like GitHub webhooks or Telegram messages<sup>18</sup>. The fundamental drawback is its guardrail system, which is limited to a primitive openclaw pairing approve command for channel authentication rather than a typed inbox for transactional approvals<sup>1</sup>.

#### The Stateful Memory Frameworks: Letta

Letta (formerly MemGPT) is heavily optimized for stateful, long-running agents with persistent, tiered memory<sup>20</sup>. By 2026, it features "Letta Code," a memory-first coding agent CLI, and supports periodic background execution ("dreaming") via /sleeptime and heartbeats<sup>20</sup>. It runs locally under an Apache 2.0 license and uses an integrated SQLite and pgvector setup for its memory system, allowing it to easily scale on a personal machine<sup>21</sup>. While exceptional for agents that need to "remember" preferences over time through archival and recall memory, Letta is structured primarily around chat-based interaction and code generation rather than strict, typed workflow automation<sup>21</sup>. It lacks a generalized execution registry for structured external tools like Notion or TickTick, making it less suitable as the foundation for an event-driven operating system compared to OpenClaw.

#### The Code-First Orchestrators: LangGraph, Mastra, LlamaIndex, CrewAI, AutoGen

This cohort represents the standard library of AI agent orchestration, but they vary wildly in their applicability as a background operating system.

LangGraph is a low-level orchestration framework designed for building stateful agents via a graph architecture<sup>24</sup>. It provides supreme control over state transitions and supports native interrupt() functions for HITL<sup>8</sup>. Running the in-memory version via langgraph-cli\[inmem\] satisfies the lightweight constraint, successfully avoiding the heavier Dockerized LangGraph Platform<sup>9</sup>. However, it is fundamentally a state machine library, not an OS runtime<sup>8</sup>. The developer remains responsible for building the scheduling loops, the cron mechanisms, and the durable retry logic if the in-memory server restarts.

Mastra has evolved into a prominent TypeScript framework featuring a code-first graph workflow engine<sup>4</sup>. It runs as a standalone Node.js server and handles multi-step processes with .then(), .branch(), and .parallel() syntax<sup>5</sup>. For HITL, Mastra utilizes .suspend() to pause workflows, storing execution state in a local storage adapter (like SQLite) until a human resolves the interruption<sup>5</sup>. While exceptionally light, it carries a significant licensing trap: the "Agent Builder" UI and advanced features reside in the ee/ (Enterprise Edition) directory, requiring a commercial license<sup>6</sup>.

CrewAI and Microsoft AutoGen (including AG2) dominate the multi-agent conversational space. CrewAI excels at sequential, role-based handoffs, while AutoGen facilitates dynamic conversations between specialized agents<sup>22</sup>. However, both frameworks are primarily designed as synchronous scripts triggered by a user prompt. They lack native daemonization, persistent background scheduling (cron), and the durable state recovery required to operate as an always-on macOS assistant. Similarly, LlamaIndex Workflows provides excellent event-driven orchestration for RAG pipelines but lacks the OS-level persistence required for Samaritan.

#### Durable Execution & Workflow Engines: Inngest, Trigger.dev, Restate

These tools solve the "run-loop and retry" commodity problem but often violate the "Light" constraint. Trigger.dev (v3) focuses on background jobs with durable checkpoints, utilizing v8 isolates for sandboxing<sup>14</sup>. Inngest utilizes step-function durability to replay state<sup>28</sup>. While their SDKs are elegant, self-hosting their control planes requires running PostgreSQL, Redis, and multiple Node services, presenting an enterprise-like operational burden just to run on a single laptop<sup>12</sup>.

Restate takes a distinct, mechanically superior approach. It offers durable execution and event sourcing based on "Virtual Objects"<sup>30</sup>. Developers write standard Go or TypeScript code, while the Restate server proxies the execution, journaling every step to ensure deterministic replay upon failure<sup>30</sup>. This is highly resilient on a volatile laptop<sup>8</sup>. However, Restate demands running a separate Rust-based or Go-based server alongside the application logic, increasing operational complexity without providing AI-specific primitives like prompt management or native MCP bindings<sup>30</sup>.

#### The Low-Code Heavyweights: n8n, Activepieces, Dify, Flowise, Windmill, Kestra

Visual workflow engines have rapidly assimilated AI capabilities. Activepieces (2026 iteration) offers 280+ MCP servers and visual agent builders<sup>12</sup>. Flowise and Dify provide drag-and-drop LangChain and agent orchestration<sup>12</sup>. Windmill offers extremely fast script orchestration via Rust<sup>32</sup>. However, they universally fail the constraints. First, their operational footprints require heavy Docker Compose stacks with databases and message queues. Second, n8n and Activepieces utilize "fair-code" or open-core models, strictly violating the OSI-approved preference<sup>12</sup>. Third, enterprise tools like Kestra (JVM/Elasticsearch) and Prefect are built for massive data pipelines, not a single-user laptop<sup>12</sup>.

#### Cloud/Vendor-Locked Platforms: Cloudflare, Anthropic, Claude SDK

The Claude Agent SDK provides excellent client-side tool calling, but as a stateless client, it possesses no run-loop or cron capabilities. Cloudflare Agents (running on Durable Objects) and Anthropic Managed Agents offer zero-infrastructure deployment, but strictly violate the zero-cost, self-hosted, and local-first constraints<sup>28</sup>. They mandate usage billing and require exfiltrating the user's private Obsidian vault to the cloud, rendering them entirely unsuitable.

## 3. Category 2: HITL Inbox and Approval Surface Inventory

The HITL surface evaluation must determine whether existing tools offer a genuine reviewable inbox with typed contracts, edit-before-approve capabilities, policy escalation, and structural locks (the "money never auto" guarantee), or if they merely offer generic suspension primitives.

### Comparison Table: HITL & Approval Surfaces

| **Tool** | **Primitives vs. Inbox** | **Typed Contracts** | **Edit & Approve** | **Policy Engine** | **Audit Trail** | **Multi-channel** |
|----|----|----|----|----|----|----|
| **HumanLayer** | Primitive + Dashboard | Basic JSON | No (mostly text) | No (manual) | Basic logging | Slack/Email |
| **LangGraph Inbox** | Inbox (React App) | Basic JSON Schema | Yes (via args edit) | No | No | Web only |
| **AG-UI (CopilotKit)** | UI Protocol | Yes (React GenUI) | Yes | No | No | Protocol-dependent |
| **Cordum.io** | Action Firewall | Basic schema | Yes | Yes (Rules) | Yes (Cryptographic) | Webhooks |
| **Inngest / Trigger** | Wait/Suspend nodes | Code-level only | No | No | Execution log | Build-your-own |
| **Activepieces/n8n** | Visual Input Nodes | Form variables | No | No | Execution log | Email links |
| **Appsmith/ToolJet** | Custom UI Builders | Yes (via DB schema) | Yes | No (requires DB) | No | Web only |
| **PWOS Core (Ref)** | Inbox + Substrate | Yes (Zod/Strict) | Yes | Yes (Tiered) | Immutable / Hash | Webhooks |
| **Camunda (Ref)** | Heavy Inbox | Yes (Form-js) | Yes | Yes (SLA/Queue) | Yes (DB-backed) | Web only |
| **UiPath (Ref)** | Heavy Inbox | Yes (Custom UI) | Yes | Yes (Routing) | Yes (DB-backed) | Web / Mobile |

### Deep Dive Analysis

#### The Agent Firewalls: HumanLayer and Cordum.io

HumanLayer positions itself specifically as HITL infrastructure for AI agents, offering an API and SDK (Apache 2.0) that injects a require_approval() decorator onto high-stakes tool calls<sup>7</sup>. By 2026, it utilizes a Go-based agentcontrolplane for outer-loop scheduling<sup>17</sup>. While it successfully intercepts tool calls and routes them to humans via Slack or email<sup>16</sup>, it fundamentally fails the Samaritan differentiators. The approval payload is standard JSON; it lacks dynamic render schemas (e.g., rendering a visual diff for a Notion page edit). There is no onboard policy engine to dynamically calculate blast radius—if a tool is decorated, it interrupts every time. Furthermore, its multi-channel delivery heavily implies reliance on their SaaS backend for webhook routing, complicating the zero-cost constraint<sup>16</sup>.

Cordum.io is an emerging 2026 project branded as the "action firewall for AI agents"<sup>17</sup>. Written in Go, it enforces policy and human approval before risky tool calls or production changes, accompanied by an auditable evidence trail<sup>17</sup>. While closer to Samaritan's policy engine than HumanLayer, adapting a Go-based firewall to run smoothly as a single macOS process alongside a TypeScript agent runtime introduces unwanted cross-language complexity.

#### The Primitive Pausers: LangGraph, Mastra, Inngest

Tools like LangGraph (interrupt()), Mastra (.suspend()), and Inngest (step.waitForEvent()) provide the raw mechanical ability to pause a workflow and wait for external input<sup>5</sup>. However, as noted in developer critiques from 2026, these primitives constitute only the bottom 10% of a functional HITL system<sup>8</sup>. They lack routing, timeout handling, and delegation logic. A request can sit stalled forever unless the developer builds the entire surrounding orchestration layer<sup>8</sup>. The framework provides the pause button but leaves the entire human-side workflow as an exercise for the developer.

#### The Inbox Scaffolds: LangGraph Agent Inbox and AG-UI

The LangChain Agent Inbox is an MIT-licensed, open-source React application provided as a reference implementation for handling LangGraph's interrupt()<sup>9</sup>. It listens for HumanInterrupt payloads and successfully implements four core actions: accept, edit (allowing modification of tool arguments before resumption), respond, and ignore<sup>25</sup>. While it is the closest open-source match to the visual requirements of an Action Center, it is entirely "dumb." It possesses no local SQLite store, no audit trail, and no policy evaluation<sup>8</sup>.

AG-UI (Agent-User Interaction) by CopilotKit is a 2026 protocol standardizing the connection between agentic backends and web clients via Server-Sent Events (SSE)<sup>10</sup>. It natively supports "Human in the Loop" function approvals and "Tool-based Generative UI," which allows a system to dynamically render a React component based on the tool's expected schema<sup>10</sup>. This directly solves Samaritan's requirement for *per-item render schemas*. However, AG-UI is merely a protocol layer. It enforces no backend structural locks, handles no durable event storage, and relies on Copilot Cloud for advanced telemetry, meaning the user must still build the underlying database<sup>11</sup>.

#### Rapid Internal Tool Builders: Appsmith, Budibase, ToolJet

These platforms excel at generating React-based CRUD interfaces rapidly over a database. If the Samaritan backend was purely SQLite, an Appsmith dashboard could visualize the pending approval queue effortlessly. However, they are generic database viewers. They lack the nuanced Generative UI capabilities of AG-UI, making it exceptionally difficult to render dynamic, polymorphic tool contracts (e.g., rendering a document diff alongside a calendar scheduling block) natively within their grid systems.

#### The Enterprise Gold Standards (Prior Art): Camunda and UiPath

Camunda Tasklist and UiPath Action Center perfectly illustrate what "good" looks like at an enterprise scale. Camunda Tasklist prioritizes tasks, utilizes form-js for contextual schema rendering, and maintains a rigorous audit trail of every decision, ensuring regulators can see a complete history without reconstructing memory<sup>13</sup>. UiPath Action Center enables robots to pause via long-running workflows, dynamically assigning exceptions to humans and resuming once validation is provided<sup>36</sup>. Both utilize strict SLAs, conditional routing, and structural locks<sup>13</sup>. However, their reliance on massive Java/JVM backends, relational databases, and enterprise licensing renders them fundamentally incompatible with a lightweight macOS laptop OS<sup>13</sup>.

#### PWOS Core (Prior Art)

Protocol Wealth OS (PWOS) Core is an Apache 2.0 open-source framework built for SEC-regulated entities<sup>14</sup>. It contains the exact architectural patterns missing in standard AI tools: a "Review-items state machine," strict Tier 2 HITL patterns, and an immutable audit log<sup>14</sup>. It utilizes a deterministic policy engine to ensure compliance<sup>14</sup>. While focused on finance, its underlying primitives—Zod schemas, Drizzle ORM, and workflow state machines—represent the exact substrate required to build Samaritan's differentiated Action Center.

## 4. Category 3: Full-Stack Replacements

The prompt indicated a willingness to abandon the existing v0 codebase if a single off-the-shelf "personal agentic OS" replicates both the runtime and the Action Center components simultaneously.

### Comparison Table: Full-Stack Candidates

| **Tool** | **Runtime Capability** | **HITL / Inbox Capability** | **Proximity to Samaritan** | **License** | **Constraint Fit** |
|----|----|----|----|----|----|
| **OpenClaw** | Excellent (Daemon) | Poor (Generic chat allow/deny) | 60% (Replaces plumbing) | OSS | High |
| **Heym.run** | Good (Visual/Code) | Moderate (Approval nodes) | 40% (Replaces orchestration) | Source-avail | Low |
| **Activepieces** | Good (Visual) | Moderate (Human Input Node) | 40% (Replaces orchestration) | Fair-code | Low |

### Deep Dive Analysis

#### OpenClaw

As a full-stack personal OS, OpenClaw excels at establishing the local-first, always-on environment<sup>1</sup>. It manages its own SQLite workspaces, interfaces seamlessly with external APIs (like GitHub) via MCP<sup>2</sup>, and surfaces notifications natively to macOS menu bars or Telegram<sup>1</sup>. However, out of the box, it lacks the graphical Action Center inbox. Its HITL paradigm forces the user to approve transactions via generic chat commands (e.g., typing /approve) rather than reviewing a structured UI diff<sup>1</sup>. If adopted as a full-stack replacement, the user must still fork the frontend or bolt on a custom React dashboard to achieve the visual Autonomy Gradient.

#### Heym.run and Activepieces

Both platforms represent the 2026 convergence of workflow automation and AI orchestration<sup>12</sup>. Activepieces introduced the "Human Input node," which pauses execution and emails the user a link to an approval screen with custom action buttons<sup>12</sup>. Heym.run offers similar RAG, MCP, and HITL nodes<sup>40</sup>. While they provide a full stack (runner + inbox), their visual programming paradigms are antithetical to a code-first, Zod-schema driven policy engine. Abstracting the execution layer to a visual node graph means that implementing a structural "money never auto" lock would require precarious JavaScript scripting within a UI node, severely weakening the architectural guarantee<sup>12</sup>.

## 5. Gap Analysis: The Differentiated Action Center vs. Off-the-Shelf Whitespace

The central hypothesis to test is whether any lightweight, OSS, agent-native tool provides the specific typed, policy-driven, and audited HITL that Samaritan requires. The analysis confirms that **this specific configuration is entirely whitespace.**

The commercial and OSS markets have solved for "pause and wait for input" via generic suspension primitives<sup>5</sup>. However, the logic surrounding *why, how, and when* to interrupt is entirely missing. Comparing market realities against the six Samaritan differentiators reveals the exact boundaries of the Buy/Build line:

1.  **Policy Engine (Confidence + Reversibility + Blast-Radius):** **Whitespace.** Tools like LangGraph and Mastra trigger an interrupt blindly when a specific node is reached<sup>5</sup>. They do not compute blast radius dynamically. The logic to evaluate a Zod manifest, assess the agent's confidence score, and determine if an action is naturally reversible (e.g., drafting an email vs. sending an email) does not exist in any lightweight runtime.

2.  **Structural "Money-Never-Auto" Lock:** **Whitespace.** OpenClaw, LangGraph, and HumanLayer execute whatever tool is mapped to the agent<sup>1</sup>. Guaranteeing that specific classes of actions cannot bypass the inbox requires a transactional lock at the database level (similar to PWOS Core's compliance gates)<sup>14</sup>. Off-the-shelf tools rely on the LLM's behavioral prompt or a flimsy Python if statement to route executions, which is insufficient for high-stakes locks.

3.  **Per-Item Render Schemas:** **Partially Solved.** The AG-UI protocol and LangGraph Agent Inbox handle dynamic UI rendering based on tool schemas<sup>10</sup>. However, defining the custom visual diffs (e.g., rendering a TickTick schedule change differently than a Notion document edit) remains a custom implementation task on the frontend.

4.  **Autonomy Gradient (Guided → Assisted → Automated):** **Whitespace.** Market tools assume binary states: the agent acts autonomously, or the human acts manually<sup>41</sup>. The gradient—where an agent drafts an action (Guided), attempts execution but requires a final click (Assisted), or executes fully (Automated)—requires a state machine lifecycle (pending → in-review → approved → awaiting-confirmation → executed) that no simple agent framework provides out of the box.

5.  **Append-Only Audit Substrate:** **Whitespace.** LangGraph provides runtime traces via LangSmith (a hosted observability platform), while Restate provides a deterministic journal for system replay rather than user-facing audits<sup>24</sup>. For a local-first, offline-capable audit trail proving *why* an action occurred, a local SQLite append-only log must be built.

6.  **Earn-Autonomy:** **Whitespace.** The concept of the system auto-tuning thresholds based on historical approval data (e.g., "The user has approved 50 consecutive calendar invites; lower the confidence threshold for auto-execution") requires long-term analytical memory applied to policy configurations. Letta provides agent memory, but no tool provides system-level policy memory<sup>20</sup>.

## 6. Recommendations and Build vs. Buy Verdict

The hypothesis holds true: schedulers, run-loops, and basic pause/resume mechanics are highly commoditized and should not be hand-built. However, the differentiated Action Center is true whitespace and must be retained as custom code.

**Component 1: Agent Runtime (The "Run Layer")**

- **Verdict:** **BUY (Adopt).** Hand-building daemons, retry queues, and context protocols is wasted effort on undifferentiated plumbing.

- **Recommendation:** Adopt **OpenClaw**.

- **Reasoning:** OpenClaw is the only tool architecturally aligned with a personal, macOS-based OS. Its openclaw onboard --install-daemon command instantly solves the launchd lifecycle management<sup>1</sup>. It natively handles webhooks, scheduling, and local-first memory, passing outputs seamlessly through established channels<sup>3</sup>.

- **Alternative (If Pure Code-First is preferred):** Adopt **Mastra** (using strictly the Apache 2.0 core). It offers a superior TypeScript workflow graph and explicit .suspend() logic for local execution, avoiding the daemon model in favor of a clean Node.js server<sup>4</sup>.

**Component 2: HITL Inbox / Action Center**

- **Verdict:** **BUILD (Scaffold the UI, Custom-Build the Logic).**

- **Recommendation for Inbox UI:** Scaffold from the **LangGraph Agent Inbox** (MIT) or utilize the **AG-UI** React primitives to accelerate frontend development<sup>9</sup>.

- **Recommendation for Action Center Logic:** Retain the custom v0 SQLite backend. None of the off-the-shelf tools provide the policy engine, the autonomy gradient, or the strict append-only audit trail required to guarantee the "money never auto" lock.

- **Reasoning:** Attempting to force LangGraph or Activepieces to perform dynamic blast-radius calculations and manage structural locks will result in fighting the framework. The differentiation of Samaritan *is* the SQLite store with its Zod schemas and policy predicates. Connect the adopted runtime (OpenClaw/Mastra) to this custom ingest API via standard HTTP POST operations.

**Full-Stack Verdict**

- **Verdict:** **Do not adopt a full-stack tool.** No single lightweight OSS project merges a durable macOS daemon with a strictly audited, policy-gated visual inbox. Attempting to use a visual orchestrator like Activepieces compromises the code-first architectural rigor<sup>12</sup>, while OpenClaw alone lacks the necessary visual UI precision for high-stakes document reviews<sup>1</sup>.

## 7. Shortlists

### A. Adopt: Fits Constraints (Personal, Light, Cheap, OSS)

1.  **OpenClaw**: The premier local-first AI assistant daemon. OSI-approved, macOS native, handles skills, MCP, and background persistence flawlessly without heavy databases<sup>1</sup>.

2.  **Mastra (Core)**: Fast, lightweight TypeScript workflow engine. Superb for building pure-code agent architectures with suspension capabilities, running as a single Node process<sup>4</sup>.

3.  **LangGraph Agent Inbox**: A bare-minimum MIT-licensed React scaffold for interacting with interrupted agent states. The ideal UI starting point<sup>9</sup>.

4.  **AG-UI (CopilotKit)**: Excellent protocol and UI components for rendering dynamic React interfaces based on tool schemas<sup>10</sup>.

5.  **Letta (MemGPT)**: Best-in-class for long-horizon memory management via SQLite, though weaker on strict structural workflows than OpenClaw<sup>21</sup>.

### B. Reference / Prior-Art Only (Too Heavy, Enterprise, or Paid to Run)

1.  **PWOS Core**: The definitive blueprint for building a local SQLite-backed compliance/audit log with structural tier-gates and Zod contracts<sup>14</sup>.

2.  **Camunda Tasklist**: The gold standard for queue-based task management, context-specific form rendering, and SLA tracking. Far too heavy to run (Java/BPMN), but the conceptual model is perfect prior-art for the Action Center<sup>13</sup>.

3.  **UiPath Action Center**: Demonstrates flawless execution of long-running workflows pausing for human validation and resuming dynamically across departments<sup>36</sup>.

4.  **Cordum.io**: An excellent conceptual reference for an "action firewall" evaluating agent tool calls, though utilizing Go rather than a TypeScript ecosystem<sup>17</sup>.

5.  **Activepieces**: A masterclass in MCP integration (280+ servers), but disqualified by its fair-code/open-core license and reliance on Docker Compose visual programming<sup>12</sup>.

## 8. Risks & Flags (2026 Landscape)

As of mid-2026, the agentic infrastructure space presents several operational risks that must be navigated carefully during adoption:

- **Licensing Traps (Open Core / Fair Code):** The ecosystem is aggressively monetizing UI components. While Mastra's core engine is Apache 2.0, its Agent Builder UI is restricted behind an Enterprise Edition (EE) license<sup>6</sup>. Similarly, workflow orchestrators like n8n and Activepieces heavily utilize fair-code models, which restrict usage limits or mandate purchasing if certain revenue thresholds are met<sup>12</sup>. Any dependency must undergo a strict audit of its LICENSE file (e.g., verifying ee/ directory exclusions).

- **The "Agent-to-Agent" (A2A) Shift:** Protocols are rapidly shifting from Agent-User interaction (AG-UI) to Agent-to-Agent (A2A) communication via the Model Context Protocol (MCP)<sup>11</sup>. Tools that do not natively support standard MCP servers will likely be abandoned by late 2026. Fortunately, OpenClaw and Mastra have adopted MCP as a primary primitive<sup>2</sup>.

- **LangGraph Lock-in & Deprecation:** The LangGraph ecosystem requires constant vigilance. Functions change rapidly (e.g., the deprecation of LoopAgent in favor of updated Workflow classes observed in 2026)<sup>8</sup>. Furthermore, deep integration risks tying the architecture to LangSmith, their proprietary hosted observability platform, violating the local-first constraint<sup>24</sup>.

- **HumanLayer Backend Dependency:** While the HumanLayer SDK is Apache 2.0, the operational requirements of the agentcontrolplane must be verified. If the system mandates routing webhook responses through humanlayer.dev servers, it explicitly violates the privacy-by-design requirement for reading local Obsidian vaults<sup>16</sup>.

- **Re-verification Requirements:** Before finalizing the architecture, the Mastra repository must be cloned to confirm the exact boundary between the OSS core and the EE modules. Additionally, verify if OpenClaw has introduced a native React dashboard module in recent 2026 patches, which could circumvent the need to build the Inbox scaffold entirely from scratch.

#### Works cited

1.  OpenClaw — Personal AI Assistant - GitHub, [<u>https://github.com/openclaw/openclaw</u>](https://github.com/openclaw/openclaw)

2.  OpenClaw and GitHub automation for PR reviews and CI monitoring - LumaDock, [<u>https://lumadock.com/tutorials/openclaw-github-automation-pr-reviews-ci-monitoring</u>](https://lumadock.com/tutorials/openclaw-github-automation-pr-reviews-ci-monitoring)

3.  OpenClaw — Personal AI Assistant, [<u>https://openclaw.ai/</u>](https://openclaw.ai/)

4.  Mastra: TypeScript AI Framework for Agents and Apps, [<u>https://mastra.ai/</u>](https://mastra.ai/)

5.  Mastra is the modern TypeScript framework for AI-powered applications and agents. - GitHub, [<u>https://github.com/mastra-ai/mastra</u>](https://github.com/mastra-ai/mastra)

6.  mastra/LICENSE.md at main - GitHub, [<u>https://github.com/mastra-ai/mastra/blob/main/LICENSE.md</u>](https://github.com/mastra-ai/mastra/blob/main/LICENSE.md)

7.  humanlayer/humanlayer.md at main - GitHub, [<u>https://github.com/humanlayer/humanlayer/blob/main/humanlayer.md</u>](https://github.com/humanlayer/humanlayer/blob/main/humanlayer.md)

8.  r/agentdevelopmentkit - Reddit, [<u>https://www.reddit.com/r/agentdevelopmentkit/</u>](https://www.reddit.com/r/agentdevelopmentkit/)

9.  langchain-ai/agent-inbox-langgraph-example - GitHub, [<u>https://github.com/langchain-ai/agent-inbox-langgraph-example</u>](https://github.com/langchain-ai/agent-inbox-langgraph-example)

10. AG-UI Integration with Agent Framework - Microsoft Learn, [<u>https://learn.microsoft.com/en-us/agent-framework/integrations/ag-ui/</u>](https://learn.microsoft.com/en-us/agent-framework/integrations/ag-ui/)

11. AG-UI Protocol - CopilotKit, [<u>https://www.copilotkit.ai/ag-ui</u>](https://www.copilotkit.ai/ag-ui)

12. Top 7 Open-Source AI Low/No-Code Tools in 2026: A Comprehensive Analysis of Leading Platforms - htdocs.dev, [<u>https://htdocs.dev/posts/top-7-open-source-ai-lowno-code-tools-in-2026-a-comprehensive-analysis-of-leading-platforms/</u>](https://htdocs.dev/posts/top-7-open-source-ai-lowno-code-tools-in-2026-a-comprehensive-analysis-of-leading-platforms/)

13. Camunda Tasklist \| One Workspace for Every Human Task in Your Process, [<u>https://camunda.com/platform/tasklist/</u>](https://camunda.com/platform/tasklist/)

14. GitHub - Protocol-Wealth/pwos-core: Open source compliance-first AI operating system for SEC-registered investment advisers. Apache 2.0 licensed with defensive patent grant., [<u>https://github.com/Protocol-Wealth/pwos-core</u>](https://github.com/Protocol-Wealth/pwos-core)

15. Agent Builder overview \| Mastra Docs, [<u>https://mastra.ai/docs/agent-builder/overview</u>](https://mastra.ai/docs/agent-builder/overview)

16. HumanLayer: Human-in-the-Loop infra for AI Agents \| Product Hunt, [<u>https://www.producthunt.com/products/humanlayer</u>](https://www.producthunt.com/products/humanlayer)

17. human-in-the-loop · GitHub Topics, [<u>https://github.com/topics/human-in-the-loop</u>](https://github.com/topics/human-in-the-loop)

18. How to Connect GitHub to OpenClaw: AI Code Review Assistant \| SFAI Labs, [<u>https://sfailabs.com/guides/connect-github-to-openclaw</u>](https://sfailabs.com/guides/connect-github-to-openclaw)

19. Connect OpenClaw to Github - Friends of the Crustacean - Answer Overflow, [<u>https://www.answeroverflow.com/m/1472693077813756044</u>](https://www.answeroverflow.com/m/1472693077813756044)

20. GitHub - letta-ai/letta-code: Stateful agents that are like people, with memory, identity, and the ability to learn and adapt, [<u>https://github.com/letta-ai/letta-code</u>](https://github.com/letta-ai/letta-code)

21. Letta \| Ry Walker Research, [<u>https://rywalker.com/research/letta</u>](https://rywalker.com/research/letta)

22. Deploy Letta \| Open-Source Stateful AI Agent Framework - Railway, [<u>https://railway.com/deploy/letta-ai-agent</u>](https://railway.com/deploy/letta-ai-agent)

23. Letta Code download \| SourceForge.net, [<u>https://sourceforge.net/projects/letta-code.mirror/</u>](https://sourceforge.net/projects/letta-code.mirror/)

24. langchain-ai/langgraph: Build resilient agents. - GitHub, [<u>https://github.com/langchain-ai/langgraph</u>](https://github.com/langchain-ai/langgraph)

25. GitHub - langchain-ai/agent-inbox: An inbox UX for interacting with human-in-the-loop agents., [<u>https://github.com/langchain-ai/agent-inbox</u>](https://github.com/langchain-ai/agent-inbox)

26. LangChain and LangGraph are DEAD? So what to USE!! \| by Ankita Tripathi - Medium, [<u>https://medium.com/@writertripathi/langchain-and-langgraph-are-dead-so-what-to-use-4a6033621fce</u>](https://medium.com/@writertripathi/langchain-and-langgraph-are-dead-so-what-to-use-4a6033621fce)

27. Visual Workflow Builder for Code-First AI Agents (React SDK), [<u>https://www.workflowbuilder.io/ai-agent-workflows</u>](https://www.workflowbuilder.io/ai-agent-workflows)

28. andreibesleaga/awesome-agentic-ai-js: Agentic AI with JavaScript/TypeScript - GitHub, [<u>https://github.com/andreibesleaga/awesome-agentic-ai-js</u>](https://github.com/andreibesleaga/awesome-agentic-ai-js)

29. @inngest/use-agent CDN by jsDelivr - A CDN for npm and GitHub, [<u>https://www.jsdelivr.com/package/npm/@inngest/use-agent</u>](https://www.jsdelivr.com/package/npm/@inngest/use-agent)

30. Kitaru vs Restate: Durable execution, shaped for Python agents - ZenML, [<u>https://www.zenml.io/compare/kitaru-vs-restate</u>](https://www.zenml.io/compare/kitaru-vs-restate)

31. Stop Letting AI Go Off-Script: Building a Context-Governed Workflow. \| by sparkss \| Medium, [<u>https://medium.com/@spparks\_/stop-letting-ai-go-off-script-building-a-constraint-based-context-pipeline-4c2621cfbb94</u>](https://medium.com/@spparks_/stop-letting-ai-go-off-script-building-a-constraint-based-context-pipeline-4c2621cfbb94)

32. Leveraging the DAO for Edge-to-Cloud Data Sharing and Availability - MDPI, [<u>https://www.mdpi.com/1999-5903/18/1/37</u>](https://www.mdpi.com/1999-5903/18/1/37)

33. Leveraging the DAO for Edge-to-Cloud Data Sharing and Availability - Preprints.org, [<u>https://www.preprints.org/manuscript/202512.2121</u>](https://www.preprints.org/manuscript/202512.2121)

34. User tasks \| Camunda 8 Docs, [<u>https://docs.camunda.io/docs/components/modeler/bpmn/user-tasks/</u>](https://docs.camunda.io/docs/components/modeler/bpmn/user-tasks/)

35. Custom Tasklist examples \| Camunda, [<u>https://camunda.com/blog/2018/02/custom-tasklist-examples/</u>](https://camunda.com/blog/2018/02/custom-tasklist-examples/)

36. UiPath Action Center - Automate a broader range of processes by helping robots and people collaborate more effectively., [<u>https://www.uipath.com/hubfs/resources/images/products/studioX/UiPath-Action-Center_Brochure.pdf</u>](https://www.uipath.com/hubfs/resources/images/products/studioX/UiPath-Action-Center_Brochure.pdf)

37. Human Robot Collaboration - Unattended Automation - UiPath, [<u>https://www.uipath.com/product/action-center</u>](https://www.uipath.com/product/action-center)

38. Human in the loop automation for customer onboarding using UiPath Action Center, [<u>https://www.uipath.com/community-blog/tutorials/human-in-the-loop-automation0-for-customer-onboarding-using-action-center</u>](https://www.uipath.com/community-blog/tutorials/human-in-the-loop-automation0-for-customer-onboarding-using-action-center)

39. Camunda BPM 7.2: Tasklist and Javascript Forms SDK (English) \| PDF - Slideshare, [<u>https://www.slideshare.net/slideshow/2015-0107-tasklist-en/43502567</u>](https://www.slideshare.net/slideshow/2015-0107-tasklist-en/43502567)

40. AI Workflow Automation Blog — Guides & Tutorials - Heym, [<u>https://heym.run/blog</u>](https://heym.run/blog)

41. Human-in-the-Loop AI \| Definition and More - Activepieces Resources, [<u>https://resources.activepieces.com/glossary/human-in-the-loop-ai</u>](https://resources.activepieces.com/glossary/human-in-the-loop-ai)

42. agent-inbox-langgraph-example/.env.example at main - GitHub, [<u>https://github.com/langchain-ai/agent-inbox-langgraph-example/blob/main/.env.example</u>](https://github.com/langchain-ai/agent-inbox-langgraph-example/blob/main/.env.example)

43. GitHub - humanlayer/humanlayer: The best way to get AI coding agents to solve hard problems in complex codebases., [<u>https://github.com/humanlayer/humanlayer</u>](https://github.com/humanlayer/humanlayer)
