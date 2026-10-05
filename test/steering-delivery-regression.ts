/**
 * Local patch (src/steering-delivery.ts): a user message sent while a
 * bridged tool runs reaches Claude as a user message written to the running
 * CLI, not as text inside the tool result. OpenCode's own notices go the
 * same way but are not marked as typed by the user. What cannot be sent
 * like that (a document, a failed write) still rides the tool result.
 * Upstream's steering-regression.ts keeps covering a handle with no sender.
 *
 * Run: bun test/steering-delivery-regression.ts
 */
import {
  assert,
  bashTool,
  callTool,
  mockHandle,
  sleep,
  startMockedProxy,
  textDelta,
} from "./helpers.ts";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const PDF = "data:application/pdf;base64,JVBERi0=";
const NOTICE =
  "<system-update>\nThe instructions from /repo/AGENTS.md changed. Here's the diff:\n+ use tabs\n</system-update>";

type Sent = {
  message: { content: Array<Record<string, any>> };
  origin?: { kind: string };
  isSynthetic?: boolean;
  client_composed?: boolean;
};

async function main() {
  const { toUserMessage } = await import("../src/steering-delivery.ts");

  const typed = toUserMessage([{ type: "text", text: "use port 8080" }]);
  assert.deepEqual(typed.message, {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "use port 8080" }] },
    parent_tool_use_id: null,
    client_composed: true,
    origin: { kind: "human" },
  });
  assert.deepEqual(typed.rest, []);

  const notice = toUserMessage([{ type: "text", text: NOTICE }]) as { message: Sent | null };
  assert.equal(notice.message?.isSynthetic, true);
  assert.equal(notice.message?.origin, undefined, "a notice is not stamped as typed by the user");
  // Text around the block means the user wrote it.
  const quoted = toUserMessage([{ type: "text", text: `what does this mean?\n${NOTICE}` }]) as {
    message: Sent | null;
  };
  assert.deepEqual(quoted.message?.origin, { kind: "human" });

  const resource = {
    type: "resource" as const,
    resource: { uri: "opencode://x.pdf", mimeType: "application/pdf", blob: "JVBERi0=" },
  };
  assert.deepEqual(toUserMessage([resource]), { message: null, rest: [resource] });

  const { post, proxy } = await startMockedProxy("steer-delivery");

  /**
   * Park a mock turn on `bash`, resume it with the tool result followed by
   * `afterResult`. Returns what the handle was sent, the tool result Claude
   * got, and the order the two arrived in.
   */
  async function run(
    session: string,
    afterResult: unknown[],
    send?: (message: Sent) => Promise<void>,
  ) {
    const sent: Sent[] = [];
    const order: string[] = [];
    let received: Array<Record<string, any>> = [];
    proxy.setClaudeQueryStarter(async (params) => ({
      ...mockHandle(
        (async function* () {
          yield { type: "system", subtype: "init", session_id: `${session}-sess` };
          const res = await callTool(params, "bash", { command: "sleep 40" });
          received = res.content;
          order.push("tool-result");
          yield { type: "user", message: { role: "user", content: [] } };
          yield textDelta("DONE");
          yield { type: "result", is_error: false, usage: {} };
        })(),
      ),
      sendUserMessage: async (message: unknown) => {
        // A write takes a moment; the tool result must wait for it.
        await sleep(20);
        if (send) await send(message as Sent);
        sent.push(message as Sent);
        order.push("user-message");
      },
    }));
    const first = (await (await post(session, {
      tools: [bashTool],
      messages: [{ role: "user", content: "run it" }],
    })).json()) as any;
    const call = first.choices[0].message.tool_calls[0];
    const resume = (await (await post(session, {
      tools: [bashTool],
      messages: [
        { role: "user", content: "run it" },
        { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: "exit 0" },
        ...afterResult,
      ],
    })).json()) as any;
    assert.match(String(resume.choices[0].message.content), /DONE/);
    return { sent, received, order };
  }
  const textOf = (blocks: Array<Record<string, any>>) =>
    blocks.map((b) => b.text ?? `<${b.type}>`).join("\n");

  try {
    // A typed message: user input, ahead of a tool result left as it was.
    const steer = await run("sd-typed", [
      { role: "user", content: "Actually, the secret word is PINEAPPLE." },
    ]);
    assert.equal(textOf(steer.received), "exit 0");
    assert.deepEqual(steer.order, ["user-message", "tool-result"]);
    assert.equal(steer.sent.length, 1);
    assert.deepEqual(steer.sent[0].message.content, [
      { type: "text", text: "Actually, the secret word is PINEAPPLE." },
    ]);
    assert.deepEqual(steer.sent[0].origin, { kind: "human" });
    assert.equal(steer.sent[0].client_composed, true);

    // A notice and a typed message keep their order and their provenance.
    const mixed = await run("sd-mixed", [
      { role: "user", content: NOTICE },
      {
        role: "user",
        content: [
          { type: "text", text: "match this mock-up" },
          { type: "image_url", image_url: { url: PNG } },
        ],
      },
    ]);
    assert.equal(textOf(mixed.received), "exit 0");
    assert.equal(mixed.sent.length, 2);
    assert.equal(mixed.sent[0].isSynthetic, true);
    assert.equal(mixed.sent[0].origin, undefined);
    assert.deepEqual(mixed.sent[1].origin, { kind: "human" });
    assert.deepEqual(
      mixed.sent[1].message.content.map((b) => b.type),
      ["text", "image"],
    );
    assert.equal(mixed.sent[1].message.content[1].source.data, "iVBORw0KGgo=");

    // A document cannot ride a queued message: the text goes as user input
    // and says so, the document stays with the tool result.
    const withPdf = await run("sd-pdf", [
      {
        role: "user",
        content: [
          { type: "text", text: "follow this spec" },
          { type: "file", file: { filename: "spec.pdf", file_data: PDF } },
        ],
      },
    ]);
    assert.equal(withPdf.sent.length, 1);
    assert.match(textOf(withPdf.sent[0].message.content), /follow this spec[\s\S]*document attachment/);
    assert.ok(withPdf.received.some((b) => b.type === "resource"), "document kept on the tool result");
    assert.doesNotMatch(textOf(withPdf.received), /follow this spec/);

    // A write that fails loses nothing: the message rides the tool result.
    const failed = await run(
      "sd-failed",
      [{ role: "user", content: "Use MANGO instead." }],
      async () => {
        throw new Error("stdin closed");
      },
    );
    assert.equal(failed.sent.length, 0);
    assert.match(textOf(failed.received), /^exit 0\n<system-reminder>[\s\S]*MANGO[\s\S]*<\/system-reminder>$/);

    // Results of one park arriving over two resume requests: sent once.
    const sent: Sent[] = [];
    const got: string[] = [];
    proxy.setClaudeQueryStarter(async (params) => ({
      ...mockHandle(
        (async function* () {
          yield { type: "system", subtype: "init", session_id: "sd-split-sess" };
          yield { type: "stream_event", event: { type: "message_start" } };
          const a = callTool(params, "bash", { command: "a" });
          const b = callTool(params, "bash", { command: "b" });
          yield { type: "stream_event", event: { type: "message_stop" } };
          for (const res of await Promise.all([a, b])) got.push(textOf(res.content));
          yield textDelta("DONE");
          yield { type: "result", is_error: false, usage: {} };
        })(),
      ),
      sendUserMessage: async (message: unknown) => {
        sent.push(message as Sent);
      },
    }));
    const turn = [{ role: "user", content: "run both" }];
    const parked = (await (await post("sd-split", { tools: [bashTool], messages: turn })).json()) as any;
    const calls = parked.choices[0].message.tool_calls;
    assert.equal(calls.length, 2);
    const asst = { role: "assistant", content: null, tool_calls: calls };
    const kiwi = { role: "user", content: "Use KIWI instead." };
    const partial = (await (await post("sd-split", {
      tools: [bashTool],
      messages: [...turn, asst, { role: "tool", tool_call_id: calls[0].id, content: "ra" }, kiwi],
    })).json()) as any;
    assert.equal(partial.choices[0].finish_reason, "tool_calls");
    const done = (await (await post("sd-split", {
      tools: [bashTool],
      messages: [
        ...turn,
        asst,
        { role: "tool", tool_call_id: calls[0].id, content: "ra" },
        { role: "tool", tool_call_id: calls[1].id, content: "rb" },
        kiwi,
      ],
    })).json()) as any;
    assert.match(String(done.choices[0].message.content), /DONE/);
    assert.equal(sent.length, 1, "steering sent once");
    assert.deepEqual(got, ["ra", "rb"]);
  } finally {
    proxy.setClaudeQueryStarter(null);
    await proxy.stopProxy();
  }
  console.log("ok — steering delivery regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
