import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "child_process";
import {
  client as acpClient,
  methods,
  ndJsonStream,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { nodeToWebWritable, nodeToWebReadable } from "../utils.js";

/**
 * Story 001 integration guard (R3.1, R3.7, R3.8 wiring): when the client does
 * NOT advertise elicitation.form and the fallback gate is ON, AskUserQuestion
 * must surface as sequential `session/request_permission` dialogs (one per
 * question, options + "Skip this question") and the selected label must round-
 * trip to the model via `updatedInput.answers`.
 *
 * Follows the repo's live-harness pattern (acp-agent.test.ts): opt-in via
 * RUN_INTEGRATION_TESTS, spawns the real agent subprocess, talks real ndJSON.
 * Red verification is therefore DEFERRED to Run mode (needs the live harness).
 */
describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)(
  "AskUserQuestion permission fallback (no elicitation capability)",
  () => {
    let child: ReturnType<typeof spawn>;

    beforeAll(async () => {
      const valid = spawnSync("tsc", { stdio: "inherit" });
      if (valid.status) {
        throw new Error("failed to compile");
      }
      child = spawn("npm", ["run", "--silent", "dev"], {
        stdio: ["pipe", "pipe", "inherit"],
        // Explicit for readability — unset also means ON (default-enabled gate).
        env: { ...process.env, ACP_ASKUSERQUESTION_FALLBACK: "1" },
      });
      child.on("error", (error) => {
        console.error("Error starting subprocess:", error);
      });
    });

    afterAll(() => {
      child.kill();
    });

    class FallbackTestClient {
      receivedText = "";
      permissionRequests: RequestPermissionRequest[] = [];
      pickedOptionIds: string[] = [];

      takeReceivedText() {
        const text = this.receivedText;
        this.receivedText = "";
        return text;
      }

      async requestPermission(
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        this.permissionRequests.push(params);
        const first = params.options.find((o) => o.kind === "allow_once");
        if (!first) {
          return { outcome: { outcome: "cancelled" } };
        }
        this.pickedOptionIds.push(first.optionId);
        return { outcome: { outcome: "selected", optionId: first.optionId } };
      }

      async sessionUpdate(params: SessionNotification): Promise<void> {
        if (
          params.update.sessionUpdate === "agent_message_chunk" &&
          params.update.content.type === "text"
        ) {
          this.receivedText += params.update.content.text;
        }
      }
    }

    it("routes AskUserQuestion through sequential permission requests and round-trips the answer", async () => {
      const input = nodeToWebWritable(child.stdin!);
      const output = nodeToWebReadable(child.stdout!);
      const stream = ndJsonStream(input, output);

      const client = new FallbackTestClient();
      const { agent: ctx } = acpClient({ name: "fallback-test-client" })
        .onNotification(methods.client.session.update, (c) => client.sessionUpdate(c.params))
        .onRequest(methods.client.session.requestPermission, (c) =>
          client.requestPermission(c.params),
        )
        .connect(stream);

      // Deliberately NO elicitation capability: this client renders permission
      // dialogs only, like Zed stable.
      await ctx.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
        },
      });

      const newSessionResponse: NewSessionResponse = await ctx.request(methods.agent.session.new, {
        cwd: process.cwd(),
        mcpServers: [],
      });

      const promptRequest: PromptRequest = {
        prompt: [
          {
            type: "text",
            text:
              "Use the AskUserQuestion tool right now to ask me to choose a favorite color. " +
              "Offer exactly two options: 'Red' and 'Blue'. Do not use any other tool and do " +
              "not ask in plain text. After I answer, reply with one short sentence naming the " +
              "color I picked.",
          },
        ],
        sessionId: newSessionResponse.sessionId,
      };
      const response: PromptResponse = await ctx.request(
        methods.agent.session.prompt,
        promptRequest,
      );
      expect(response.stopReason).toBe("end_turn");

      // The question surfaced as a permission request carrying the tool input...
      const questionRequest = client.permissionRequests.find((r) =>
        Array.isArray((r.toolCall?.rawInput as { questions?: unknown } | undefined)?.questions),
      );
      expect(questionRequest).toBeDefined();

      // ...referencing an already-emitted tool_call (R3.1)...
      expect(questionRequest!.toolCall.toolCallId).toBeTruthy();

      // ...with one allow_once per option plus the skip option (R3.3/R3.4).
      const optionIds = questionRequest!.options
        .filter((o) => o.kind === "allow_once")
        .map((o) => o.optionId);
      expect(optionIds).toContain("Red");
      expect(optionIds).toContain("Blue");
      expect(
        questionRequest!.options.some(
          (o) => o.kind === "reject_once" && o.name === "Skip this question",
        ),
      ).toBe(true);

      // The selected label round-trips into the model's reply (R3.7).
      const picked = client.pickedOptionIds[0] ?? "";
      expect(picked).not.toEqual("");
      expect(client.takeReceivedText().toLowerCase()).toContain(picked.toLowerCase());
    }, 60000);
  },
);
