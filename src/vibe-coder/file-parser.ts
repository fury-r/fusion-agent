import { VibeCoderFileChange } from './types';

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
  const regex = /```[\w.+\-]*:([^\n`]+)\n([\s\S]*?)```/g;
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
