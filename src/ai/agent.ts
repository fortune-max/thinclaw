import Anthropic from "@anthropic-ai/sdk";
import { editTelegramMessage } from "../bot/telegram.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { loadConversationContext } from "./context-window.js";
import { insertToolCall } from "../db/queries.js";
import { logger } from "../logger.js";
import {
  isDangerousToolCall,
  requestConfirmation,
} from "../security/confirmation.js";

const client = new Anthropic();

const MAX_ITERATIONS = 15;
const EDIT_THROTTLE_MS = 800;
const DEFAULT_MODEL = "claude-haiku-4-5";

export const MODEL_ALIASES: Record<string, string> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6",
};

// Per-chat model override (resets after one message)
const modelOverrides = new Map<number, string>();

export function setModelOverride(chatId: number, model: string): void {
  modelOverrides.set(chatId, model);
}

function consumeModelOverride(chatId: number): string {
  const override = modelOverrides.get(chatId);
  if (override) {
    modelOverrides.delete(chatId);
    return override;
  }
  return DEFAULT_MODEL;
}

import type { PluginInfo } from "../plugins/loader.js";

// Model pricing per 1M tokens
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-opus-4-6": { input: 5.0, output: 25.0 },
};

interface AgentRunParams {
  chatId: number;
  userMessage: string | Anthropic.MessageParam["content"];
  placeholderMessageId: number;
  tools: Anthropic.Tool[];
  executeTool: (toolName: string, input: Record<string, unknown>) => Promise<string>;
  availablePlugins: PluginInfo[];
  userName?: string | null;
}

export interface AgentResult {
  text: string;
  model: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
}

export async function runAgent(params: AgentRunParams): Promise<AgentResult> {
  const { chatId, userMessage, placeholderMessageId, tools, executeTool, availablePlugins, userName } = params;

  const systemPrompt = buildSystemPrompt(chatId, availablePlugins, userName);
  const context = loadConversationContext(chatId);

  // Build messages array with conversation history
  const messages: Anthropic.MessageParam[] = context.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  messages.push({ role: "user", content: userMessage });

  let lastText = "";
  const currentModel = consumeModelOverride(chatId);
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreateTokens = 0;

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      // Stream the response
      let accumulatedText = "";
      let lastEditTime = 0;

      const stream = client.messages.stream({
        model: currentModel,
        max_tokens: 8192,
        system: systemPrompt,
        tools,
        messages,
      });

      // Stream text deltas to Telegram
      stream.on("text", (delta) => {
        accumulatedText += delta;
        const now = Date.now();
        if (now - lastEditTime > EDIT_THROTTLE_MS) {
          lastEditTime = now;
          editTelegramMessage(chatId, placeholderMessageId, accumulatedText).catch(() => {});
        }
      });

      const response = await stream.finalMessage();

      // Track token usage
      const usage = response.usage as unknown as Record<string, number>;
      totalInputTokens += usage?.input_tokens || 0;
      totalOutputTokens += usage?.output_tokens || 0;
      totalCacheReadTokens += usage?.cache_read_input_tokens || 0;
      totalCacheCreateTokens += usage?.cache_creation_input_tokens || 0;

      // Extract final text
      const textBlocks = response.content.filter(
        (b): b is Anthropic.TextBlock => b.type === "text",
      );
      if (textBlocks.length > 0) {
        lastText = textBlocks.map((b) => b.text).join("\n");
      }

      // Check if done
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      if (response.stop_reason === "end_turn" || toolUseBlocks.length === 0) {
        await editTelegramMessage(chatId, placeholderMessageId, lastText || "(no response)").catch(() => {});
        break;
      }

      // Process tool calls
      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        const toolInput = (toolUse.input ?? {}) as Record<string, unknown>;

        // Check if dangerous — require Telegram confirmation before showing status
        if (isDangerousToolCall(toolUse.name, toolInput)) {
          const approved = await requestConfirmation(chatId, toolUse.name, toolInput);
          if (!approved) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: "User denied this action.",
              is_error: true,
            });
            continue;
          }
        }

        // Show tool usage in Telegram (after confirmation if needed)
        await editTelegramMessage(
          chatId,
          placeholderMessageId,
          (accumulatedText ? accumulatedText + "\n\n" : "") + `Using: ${toolUse.name}`,
        ).catch(() => {});

        // Execute the tool
        const startTime = Date.now();
        let result: string;
        let isError = false;

        try {
          result = await executeTool(toolUse.name, toolInput);
        } catch (err: unknown) {
          result = `Error: ${err instanceof Error ? err.message : String(err)}`;
          isError = true;
        }

        const durationMs = Date.now() - startTime;

        // Store tool call in DB
        insertToolCall({
          chatId,
          toolName: toolUse.name,
          toolInput,
          toolResult: result.slice(0, 10000),
          durationMs,
          isError,
        });

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result.slice(0, 50000), // Limit result size
          is_error: isError,
        });
      }

      messages.push({ role: "user", content: toolResults });
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err: errMsg, chatId }, "Agent run failed");
    lastText = `Error: ${errMsg}`;
    try {
      await editTelegramMessage(chatId, placeholderMessageId, lastText);
    } catch {
      logger.error({ chatId }, "Failed to send error to Telegram");
    }
  }

  const pricing = MODEL_PRICING[currentModel] || { input: 3.0, output: 15.0 };
  // input_tokens already excludes cached tokens — the three counts are disjoint
  // Cache reads cost 10%, cache creates cost 125% of input price
  const totalCostUsd =
    (totalInputTokens / 1_000_000) * pricing.input +
    (totalCacheReadTokens / 1_000_000) * pricing.input * 0.1 +
    (totalCacheCreateTokens / 1_000_000) * pricing.input * 1.25 +
    (totalOutputTokens / 1_000_000) * pricing.output;

  return {
    text: lastText,
    model: currentModel,
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd,
  };
}
