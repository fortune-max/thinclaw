import { getRecentMessages, type ConversationMessage } from "../db/queries.js";
import { config } from "../config.js";

export function loadConversationContext(chatId: number): ConversationMessage[] {
  return getRecentMessages(chatId, config.CONTEXT_WINDOW_SIZE);
}
