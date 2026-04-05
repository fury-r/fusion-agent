import { VibeCoderFileChange, BrowserBlock, AgentMessageBlock } from './types';

/**
 * Extract ```language:filepath … ``` code blocks from an AI response.
 *
 * Matches the vibe-coder convention:
 *   ```typescript:src/path/to/file.ts
 *   // complete file content
 *   ```
 */
export function extractFileBlocks(text: string): VibeCoderFileChange[] {
  const results: VibeCoderFileChange[] = [];
  // language part is optional; colon + filepath is the key indicator
  const regex = /```[\w.+-]*:([^\n`]+)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const filePath = match[1].trim();
    const content = match[2]; // preserve trailing newline intentionally
    if (filePath) {
      results.push({ filePath, content });
    }
  }
  return results;
}

/** Return true when the response contains the autonomous-completion sentinel. */
export function detectCompletion(text: string): boolean {
  return /REQUIREMENTS_COMPLETE/i.test(text);
}

/**
 * Extract <browser>…</browser> blocks from an AI response.
 *
 * Each block contains one or more newline-separated instructions:
 *   navigate https://example.com
 *   snapshot
 *   click #submit-btn
 *   type #search hello world
 *   eval document.title
 */
export function extractBrowserBlocks(text: string): BrowserBlock[] {
  const results: BrowserBlock[] = [];
  const regex = /<browser>([\s\S]*?)<\/browser>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const instructions = match[1]
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (instructions.length > 0) {
      results.push({ instructions });
    }
  }
  return results;
}

/**
 * Extract <agent>send to:<sessionId> message:<text></agent> blocks.
 *
 * Example:
 *   <agent>send to:abc-123 message:Please review the auth module</agent>
 */
export function extractAgentBlocks(text: string): AgentMessageBlock[] {
  const results: AgentMessageBlock[] = [];
  const regex = /<agent>\s*send\s+to:(\S+)\s+message:([\s\S]*?)<\/agent>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const toSessionId = match[1].trim();
    const message = match[2].trim();
    if (toSessionId && message) {
      results.push({ toSessionId, message });
    }
  }
  return results;
}
