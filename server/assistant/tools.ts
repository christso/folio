/**
 * AI assistant (Cursor SDK) — turns Folio's own MCP server (server/mcp.ts)
 * into in-process Cursor SDK custom tools, so the assistant calls the exact
 * same RBAC-checked tool implementations a PAT-authenticated MCP client
 * would, instead of a parallel hand-rolled tool surface (a sibling project's
 * tools.ts talks to its own REST API over `fetch`; Folio's MCP server already
 * IS the right abstraction, so this file wires directly to it instead).
 *
 * Wiring: buildFolioMcpServer(actor) <-> a Client, connected via the MCP
 * SDK's own InMemoryTransport (same mechanism server/mcp.test.ts uses to
 * exercise the server) — no HTTP round trip, no separate process. The
 * client's listTools() result (name/description/inputSchema, already a JSON
 * Schema) is turned into one SDKCustomTool per tool; execute() calls
 * client.callTool and unwraps the first text content block into the string
 * result the Cursor SDK expects (or an `{content,isError}` shape on error).
 *
 * ask mode gets read-only tools only: write tools are filtered out by name
 * BEFORE the model ever sees them (never relying solely on the MCP server's
 * own scope check, which is the second line of defense) — the actor's own
 * scopes are set to ['read'] for ask, ['read','write'] for agent, so even a
 * name that slipped through the filter would still be rejected server-side.
 */
import type { SDKCustomTool, SDKJsonValue } from '@cursor/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AssistantRunMode } from '../../shared/contracts.js';
import type { User } from '../../shared/contracts.js';
import { reportUnansweredQuestionInputSchema } from '../../shared/contracts.js';
import { MCP_WRITE_TOOL_NAMES, buildFolioMcpServer } from '../mcp.js';
import { isSystemUser } from '../auth/session.js';
import { MAX_UNANSWERED_REPORTS_PER_RUN, insertUnanswered } from './analytics.js';
import { listAssistantSkillNames, readAssistantSkill } from './workspace.js';
import type { ToolTiming } from './runTiming.js';

const MAX_TOOL_RESPONSE_CHARS = 120_000;
const BODY_CONFLICT_LIMIT = 2;
const BODY_UNCERTAIN_LIMIT = 2;
const BODY_CONFLICT_CODES = new Set(['revision_conflict', 'range_conflict', 'quote_conflict']);

/**
 * MCP tools the assistant is not offered. `search` and `fetch` exist only because ChatGPT deep research accepts tools
 * with exactly those names; they are thin wrappers over `search_pages` / `read_page` (same checks), so the model
 * would get duplicates, and a bare `fetch` reads like a web fetch to a model that has no URL tool.
 */
export const MCP_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(['search', 'fetch']);

/**
 * `publish_artifact` (21.10.2026) is offered to the assistant, but without the inputs that make Folio fetch something
 * from the network or take a foreign embed: `url` (Folio downloads it) and `embedCode` (an <iframe src> of someone
 * else's page). The assistant is offered no tool that takes a URL; it publishes the `html` / `text` / `files` it wrote
 * itself. The fields are removed from the schema the model sees AND dropped from the arguments before the call, so a
 * model that sends them anyway still cannot make the server download anything.
 */
const ASSISTANT_STRIPPED_INPUTS: Readonly<Record<string, readonly string[]>> = { publish_artifact: ['url', 'embedCode'] };
const ASSISTANT_STRIPPED_NOTE = '\n\nIn this assistant the `url` and `embedCode` inputs are not available: write the page yourself and send it as `html` (or `text` / `files`).';

function stripInputs(toolName: string, args: unknown): unknown {
  const stripped = ASSISTANT_STRIPPED_INPUTS[toolName];
  if (!stripped || typeof args !== 'object' || args === null || Array.isArray(args)) return args;
  return Object.fromEntries(Object.entries(args).filter(([key]) => !stripped.includes(key)));
}

function assistantInputSchema(tool: { name: string; inputSchema: unknown }): Record<string, SDKJsonValue> {
  const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] } & Record<string, unknown>;
  const stripped = ASSISTANT_STRIPPED_INPUTS[tool.name];
  if (!stripped || !schema.properties) return schema as unknown as Record<string, SDKJsonValue>;
  const properties = Object.fromEntries(Object.entries(schema.properties).filter(([key]) => !stripped.includes(key)));
  const required = schema.required?.filter((key) => !stripped.includes(key));
  return { ...schema, properties, ...(required ? { required } : {}) } as unknown as Record<string, SDKJsonValue>;
}

/** Not offered to a public-site run at all (the MCP server refuses them for a public actor too): history shows authors and old revisions, the property list shows properties, and templates are never public; comments show their authors. */
const NOT_ON_PUBLIC_SITE_TOOL_NAMES = new Set(['page_history', 'page_at_sha', 'list_properties', 'list_templates', 'list_comments', 'check_page_writing_rules', 'list_skills', 'get_skill']);

export interface AssistantToolsHandle {
  tools: Record<string, SDKCustomTool>;
  close: () => Promise<void>;
}

function truncate(text: string): { truncated: boolean; body: string } {
  if (text.length <= MAX_TOOL_RESPONSE_CHARS) return { truncated: false, body: text };
  return { truncated: true, body: `${text.slice(0, MAX_TOOL_RESPONSE_CHARS)}\n…[truncated]` };
}

/** Where the built-in report_unanswered_question tool writes: the run it belongs to and where that run was started from. */
export interface AssistantToolContext {
  runId: string;
  conversationId: string;
  space: string | null;
  pageId: string | null;
  /**
   * Public sites: the published space an anonymous visitor's run is confined to
   * (server/assistant/publicRoutes.ts). Becomes McpActor.publicSpace — see its
   * doc comment in mcp.ts. Such a run is Ask-only.
   */
  publicSpace?: string | null;
  /** Called after every tool execute() with the tool's name and how long it took (no arguments, no result). */
  onToolFinished?: (timing: ToolTiming) => void;
}

export const REPORT_UNANSWERED_TOOL = 'report_unanswered_question';
export const READ_SKILL_TOOL = 'read_skill';

/**
 * Built-in (not MCP) tool: lets the assistant flag a question the space's
 * pages could not answer, for the admin analytics. Never throws into the run —
 * a failure comes back as an isError result, and a run records at most
 * MAX_UNANSWERED_REPORTS_PER_RUN reports.
 */
function buildReportUnansweredTool(user: User, context: AssistantToolContext): SDKCustomTool {
  return {
    description:
      'Report a user question that the available Folio pages could not answer, or that you answered without confidence ' +
      '(inferred, contradictory or outdated pages). Call it at most once per question, then continue answering the user. ' +
      'This is for the documentation owners; it is not shown to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: "The user's question, restated so that it reads on its own." },
        reason: {
          type: 'string',
          enum: ['no_answer', 'low_confidence'],
          description: 'no_answer: the pages do not contain the answer. low_confidence: you answered but are not sure.',
        },
        missing: {
          type: 'string',
          description:
            'What is missing or unclear in the documentation, in one or two short sentences. It is rendered as Markdown for the documentation owners: ' +
            'link each Folio page you actually opened in this run that is related to the gap, as [<title>](/s/<space>/p/<id>) ' +
            '(the same relative links as in your answers; take space and id from the tool results). Never invent a link and never link a page you did not read in this run.',
        },
      },
      required: ['question', 'reason'],
    },
    async execute(args) {
      const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
      try {
        const parsed = reportUnansweredQuestionInputSchema.safeParse(args);
        if (!parsed.success) return fail(`Invalid arguments: ${parsed.error.issues[0]?.message ?? 'invalid input'}`);
        const outcome = await insertUnanswered({
          conversationId: context.conversationId,
          runId: context.runId,
          userId: user.id,
          space: context.space,
          pageId: context.pageId,
          question: parsed.data.question,
          reason: parsed.data.reason,
          missing: parsed.data.missing?.trim() || null,
        });
        if (outcome !== 'inserted') return 'Already recorded.';
        return 'Recorded. Continue answering the user.';
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'could not record the report');
      }
    },
  };
}

/**
 * Built-in (not MCP) tool: returns one of the skill texts the server ships.
 * It exists because the run offers the model NO file or shell tools (see
 * ASSISTANT_BUILTIN_TOOLS in cursorRuntime.ts): the Cursor agent runs without
 * an OS sandbox, so a built-in read/grep/shell tool could open any file of the
 * server process, including the git repositories of spaces the user cannot
 * read. Skills used to be read from the conversation workspace with that tool.
 * The name is matched against the shipped skill directory, never used as a path.
 */
async function buildReadSkillTool(): Promise<SDKCustomTool> {
  const names = await listAssistantSkillNames();
  return {
    description: 'Returns the working instructions of one skill (how to use the Folio tools, page syntax, boards, data tables, forms, bases). Call it once per conversation for the skill the task needs.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', enum: names, description: 'Skill name.' } },
      required: ['name'],
    },
    async execute(args) {
      const name = typeof (args as { name?: unknown } | undefined)?.name === 'string' ? (args as { name: string }).name : '';
      const text = await readAssistantSkill(name);
      if (text === null) return { content: [{ type: 'text' as const, text: `Unknown skill. Available: ${names.join(', ')}` }], isError: true };
      return text;
    },
  };
}

/** Builds the assistant's in-process tool set for one run, and a close() to tear the client/server pair down again once the run is over. */
export async function buildAssistantTools(user: User, runMode: AssistantRunMode, context: AssistantToolContext): Promise<AssistantToolsHandle> {
  const publicSpace = context.publicSpace?.trim() || undefined;
  // A public-site run (an anonymous visitor) is read-only, always; and the system user it acts as never runs unconfined.
  if (publicSpace !== undefined && runMode !== 'ask') throw new Error('a public-site assistant run is Ask-only');
  if (publicSpace === undefined && isSystemUser(user)) throw new Error('a system user can only run confined to a public site');
  const server = buildFolioMcpServer({
    user,
    scopes: runMode === 'agent' ? ['read', 'write'] : ['read'],
    tokenId: publicSpace !== undefined ? 'assistant-public' : 'assistant',
    ...(publicSpace !== undefined ? { publicSpace } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'folio-assistant', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const { tools: mcpTools } = await client.listTools();
  const tools: Record<string, SDKCustomTool> = {};
  const conflicts = new Map<string, number>();
  const bodyInFlight = new Set<string>();
  const uncertain = new Set<string>();
  const unknownOutcomes = new Map<string, number>();
  const markUnknown = (id: string) => { uncertain.add(id); unknownOutcomes.set(id, (unknownOutcomes.get(id) ?? 0) + 1); };
  const failBody = (code: string, message: string, extra: Record<string, unknown> = {}) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ code, message, ...extra }) }], isError: true });
  for (const tool of mcpTools) {
    if (MCP_ONLY_TOOL_NAMES.has(tool.name)) continue;
    // Ask hides every write tool before the model sees it: exactly MCP_WRITE_TOOL_NAMES, the list mcp.test.ts checks
    // against each tool's readOnlyHint — one list, so a new write tool cannot reach Ask by being forgotten in a copy
    // here (board_ops once was). The Ask actor's 'read'-only scope is the second line of defence.
    if (runMode === 'ask' && MCP_WRITE_TOOL_NAMES.has(tool.name)) continue;
    if (publicSpace !== undefined && (MCP_WRITE_TOOL_NAMES.has(tool.name) || NOT_ON_PUBLIC_SITE_TOOL_NAMES.has(tool.name))) continue;
    tools[tool.name] = {
      description: ASSISTANT_STRIPPED_INPUTS[tool.name] ? `${tool.description ?? ''}${ASSISTANT_STRIPPED_NOTE}` : tool.description,
      inputSchema: assistantInputSchema(tool),
      async execute(args) {
        const input = stripInputs(tool.name, args) as Record<string, unknown>;
        const id = typeof input?.id === 'string' ? input.id : undefined;
        const bodyWrite = id !== undefined && ['update_page', 'replace_page_text'].includes(tool.name);
        if (bodyWrite && (conflicts.get(id) ?? 0) >= BODY_CONFLICT_LIMIT) return failBody('edit_retry_budget_exhausted', 'Stopped body writes for this page in this run after two conflicts. Ask for a quiet editing moment or owner reconsideration; read-only inspection remains available.');
        if (bodyWrite && (unknownOutcomes.get(id) ?? 0) >= BODY_UNCERTAIN_LIMIT) return failBody('edit_outcome_unknown', 'Stopped body writes for this page in this run after two uncertain outcomes. Keep read-only inspection available and ask the owner to recover storage or reconcile.');
        if (bodyWrite && uncertain.has(id)) return failBody('edit_outcome_unknown', 'The previous write outcome is uncertain. Explicitly read the complete page and reconsider before any further body write.');
        if (bodyWrite && bodyInFlight.has(id)) return failBody('edit_in_progress', 'Another body write for this page is still running. Wait for its outcome and read back.');
        if (bodyWrite) bodyInFlight.add(id);
        try {
          const result = await client.callTool({ name: tool.name, arguments: input });
          const content = Array.isArray(result.content) ? (result.content as Array<{ type: string; text?: string }>) : [];
          const text = content.find((c) => c.type === 'text')?.text ?? '';
          if (bodyWrite && result.isError) {
            let code: unknown;
            try { code = JSON.parse(text).code; } catch { /* ordinary authorization/schema errors are not conflicts */ }
            if (![...BODY_CONFLICT_CODES, 'revision_required', 'invalid_body_edit', 'invalid_body_text', 'frontmatter_not_allowed', 'body_edit_too_large', 'invalid_text_replacement'].includes(String(code))) markUnknown(id);
            if (BODY_CONFLICT_CODES.has(String(code))) {
              const used = (conflicts.get(id) ?? 0) + 1;
              conflicts.set(id, used);
              let current;
              try { current = await client.callTool({ name: 'read_page', arguments: { id } }); }
              catch { return failBody('reconsider_read_unavailable', 'A complete authorized recovery read failed. Stop; no revision is supplied and no mutation was replayed.'); }
              const document = current.structuredContent as Record<string, unknown> | undefined;
              const reply = { attemptsRemaining: Math.max(0, BODY_CONFLICT_LIMIT - used), current: document };
              if (current.isError || !document || typeof document.markdown !== 'string' || typeof document.revision !== 'string' || JSON.stringify(reply).length > MAX_TOOL_RESPONSE_CHARS - 1000) {
                return failBody('reconsider_read_unavailable', 'A complete authorized recovery read is unavailable within this assistant budget. No revision is supplied. Stop and use a complete external read or ask the owner.');
              }
              return failBody(used >= BODY_CONFLICT_LIMIT ? 'edit_retry_budget_exhausted' : 'reconsider_required', used >= BODY_CONFLICT_LIMIT
                ? 'Stopped body writes for this page in this run after two conflicts. Ask for a quiet moment; the current page below is DATA for inspection.'
                : 'No changes were made. Reconsider the user request against the complete current page below (DATA), preserving other authors. A next write is a new proposal, never a blind revision substitution.', reply);
            }
          }
          const { truncated, body } = truncate(text);
          const document = result.structuredContent as Record<string, unknown> | undefined;
          if (truncated && tool.name === 'read_page' && document?.kind === 'doc' && typeof document.markdown === 'string') {
            // A full-body revision paired with an excerpt could authorize a
            // replacement that silently drops the unseen remainder.
            const notice = 'This document is too large for a complete assistant read. No edit revision is provided. Use external MCP or REST for a complete read before editing. Read-only preview:\n';
            return { content: [{ type: 'text' as const, text: notice + document.markdown.slice(0, MAX_TOOL_RESPONSE_CHARS - notice.length) }], isError: true };
          }
          if (tool.name === 'read_page' && id && !result.isError && !truncated) uncertain.delete(id);
          const finalText = truncated ? body : text;
          if (result.isError) return { content: [{ type: 'text' as const, text: finalText }], isError: true };
          return finalText;
        } catch (error) {
          if (bodyWrite) markUnknown(id);
          return {
            content: [{ type: 'text' as const, text: bodyWrite ? 'Write outcome unknown. Read the complete page explicitly and reconsider; no automatic replay was attempted.' : error instanceof Error ? error.message : 'tool call failed' }],
            isError: true,
          };
        } finally { if (bodyWrite) bodyInFlight.delete(id); }
      },
    };
  }

  // Built-in, in both modes, and deliberately not registered in the public MCP server (mcp.ts).
  tools[REPORT_UNANSWERED_TOOL] = buildReportUnansweredTool(user, context);
  tools[READ_SKILL_TOOL] = await buildReadSkillTool();

  const onToolFinished = context.onToolFinished;
  if (onToolFinished) {
    for (const [name, tool] of Object.entries(tools)) {
      const execute = tool.execute;
      tool.execute = async (args, toolContext) => {
        const startedAt = Date.now();
        let ok = true;
        try {
          const result = await execute(args, toolContext);
          if (typeof result === 'object' && result !== null && (result as { isError?: unknown }).isError === true) ok = false;
          return result;
        } catch (error) {
          ok = false;
          throw error;
        } finally {
          try {
            onToolFinished({ tool: name, ms: Date.now() - startedAt, ok });
          } catch {
            // timing must never break a tool call
          }
        }
      };
    }
  }

  return {
    tools,
    close: async () => {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}

