/**
 * Local patch: mid-turn messages reach Claude as user input, not tool output.
 *
 * Upstream appends a message the user sends while a bridged tool runs to
 * that tool's result (prompt.ts `withSteering`). Claude treats tool results
 * as untrusted data, so it declines to act on what arrives there. Here such
 * messages are written to the running Claude Code process as user messages
 * instead. The CLI queues them and surfaces them at the next tool boundary,
 * outside the tool result, the way it does for a message typed mid-turn in
 * Claude Code itself.
 *
 * The whole patch lives in this file. Upstream files only call into it:
 * query.ts exposes the SDK's `streamInput` on the handle, and the resume
 * branch of proxy.ts calls `deliverSteering`. Whatever cannot be sent this
 * way is handed back and still rides the tool result, as upstream does it.
 */
import { log } from "./log.js";
import type { AnthropicContentBlock, McpToolResultContent } from "./prompt.js";

export type UserMessageSender = (message: unknown) => Promise<void>;

/** Longest wait for the SDK to confirm a write before falling back. */
const WRITE_TIMEOUT_MS = 10_000;

/**
 * OpenCode's own notices (skills list changed, AGENTS.md changed) arrive as
 * user messages whose whole text is one or more `<system-update>` blocks.
 */
const NOTICE = /^(?:<system-update>[\s\S]*?<\/system-update>\s*)+$/;

const DOCUMENT_NOTE =
  "[This message came with a document attachment. It is delivered with the tool result.]";

/**
 * A sender backed by the SDK Query's `streamInput`, or undefined when the
 * SDK has none. `streamInput` itself settles only when the run ends, so the
 * sender resolves as soon as the SDK asks the input for its next message:
 * that is right after it wrote this one to the CLI.
 */
export function userMessageSender(query: unknown): UserMessageSender | undefined {
  const q = query as {
    streamInput?: (input: AsyncIterable<unknown>) => Promise<void>;
  } | null;
  if (!q || typeof q.streamInput !== "function") return undefined;
  return (message) =>
    new Promise<void>((resolve, reject) => {
      const input = (async function* () {
        yield message;
        resolve();
      })();
      Promise.resolve(q.streamInput!(input)).then(resolve, reject);
    });
}

function withTimeout(write: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    write,
    new Promise<void>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`write not confirmed after ${WRITE_TIMEOUT_MS}ms`)),
        WRITE_TIMEOUT_MS,
      );
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function isNotice(blocks: McpToolResultContent[]): boolean {
  if (!blocks.every((b) => b.type === "text")) return false;
  const text = blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");
  return NOTICE.test(text.trim());
}

/**
 * `client_composed` makes the CLI deliver the text as written. OpenCode
 * already handled the user's commands and file mentions; without the flag
 * the CLI holds a message that starts with "/" until the turn is over and
 * expands `@path` mentions a second time.
 */
function sdkUserMessage(content: AnthropicContentBlock[], provenance: Record<string, unknown>) {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    client_composed: true,
    ...provenance,
  };
}

/**
 * One steering message as an SDK user message, with the blocks it cannot
 * carry. `message` is null when nothing of it can be sent this way.
 */
export function toUserMessage(blocks: McpToolResultContent[]): {
  message: ReturnType<typeof sdkUserMessage> | null;
  rest: McpToolResultContent[];
} {
  const content: AnthropicContentBlock[] = [];
  const rest: McpToolResultContent[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      if (block.text.trim()) content.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      content.push({
        type: "image",
        source: { type: "base64", media_type: block.mimeType, data: block.data },
      });
    } else {
      // The CLI keeps only the text and images of a queued message.
      rest.push(block);
    }
  }
  if (content.length === 0) return { message: null, rest: blocks };
  // Not typed by the user: the CLI presents a synthetic message as coming
  // from a non-user source instead of as something the user sent.
  if (isNotice(blocks)) return { message: sdkUserMessage(content, { isSynthetic: true }), rest };
  if (rest.length > 0) content.push({ type: "text", text: DOCUMENT_NOTE });
  // The SDK asks hosts to stamp keyboard input as human explicitly.
  return { message: sdkUserMessage(content, { origin: { kind: "human" } }), rest };
}

/**
 * Send the steering messages of a resume request to Claude as user input.
 * Call it before resolving the tool results they followed: the CLI reads
 * both from one pipe in order, so the messages are queued by the time the
 * tool results complete and it picks them up at that boundary. A message
 * that arrives later is not lost; the CLI runs it as a turn of its own right
 * after this one, in the same stream.
 *
 * Returns the blocks that still have to ride a tool result: documents,
 * and everything when the handle cannot send or a write fails.
 */
export async function deliverSteering(
  handle: { sendUserMessage?: UserMessageSender },
  messages: McpToolResultContent[][],
): Promise<McpToolResultContent[]> {
  const send = handle.sendUserMessage;
  if (!send) return messages.flat();
  const rest: McpToolResultContent[] = [];
  let sent = 0;
  for (const [index, blocks] of messages.entries()) {
    const { message, rest: unsendable } = toUserMessage(blocks);
    if (message) {
      try {
        await withTimeout(send(message));
        sent++;
      } catch (error) {
        log.warn(
          "[opencode-claude] could not send a mid-turn message as user input; attaching it to the tool result",
          error instanceof Error ? error.message : String(error),
        );
        rest.push(...messages.slice(index).flat());
        break;
      }
    }
    rest.push(...unsendable);
  }
  log.info("[opencode-claude] sent mid-turn messages as user input", {
    sent,
    blocksOnToolResult: rest.length,
  });
  return rest;
}
