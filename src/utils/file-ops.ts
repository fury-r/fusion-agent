import fs from 'fs';
import path from 'path';
import { createPatch } from 'diff';

export interface FileChange {
  filePath: string;
  originalContent: string;
  newContent: string;
  patch: string;
}

export function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

export function writeFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, content, 'utf-8');
}

export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export function createChange(filePath: string, newContent: string): FileChange {
  const originalContent = fileExists(filePath) ? readFile(filePath) : '';
  const patch = createPatch(filePath, originalContent, newContent);
  return { filePath, originalContent, newContent, patch };
}

export function applyChange(change: FileChange): void {
  writeFile(change.filePath, change.newContent);
}

export function revertChange(change: FileChange): void {
  if (change.originalContent === '') {
    // File didn't exist before — delete it
    if (fileExists(change.filePath)) {
      fs.unlinkSync(change.filePath);
    }
  } else {
    writeFile(change.filePath, change.originalContent);
  }
}

export function getDirectoryStructure(
  dir: string,
  maxDepth = 3,
  currentDepth = 0,
  ignore = ['node_modules', '.git', 'dist', '.next', '__pycache__', '.env']
): string {
  if (currentDepth > maxDepth) return '';
  const items: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return '';
  }
  for (const entry of entries) {
    if (ignore.includes(entry.name)) continue;
    const indent = '  '.repeat(currentDepth);
    if (entry.isDirectory()) {
      items.push(`${indent}${entry.name}/`);
      const sub = getDirectoryStructure(path.join(dir, entry.name), maxDepth, currentDepth + 1, ignore);
      if (sub) items.push(sub);
    } else {
      items.push(`${indent}${entry.name}`);
    }
  }
  return items.join('\n');
}

export function gatherProjectContext(
  projectDir: string,
  maxFiles = 10,
  maxFileSize = 8000
): string {
  const structure = getDirectoryStructure(projectDir);
  const contextParts: string[] = [`# Project Structure\n\`\`\`\n${structure}\n\`\`\``];

  // Read key files for context
  const keyFiles = [
    'package.json',
    'tsconfig.json',
    'pyproject.toml',
    'requirements.txt',
    'Cargo.toml',
    'go.mod',
    'README.md',
  ];
  let filesRead = 0;
  for (const kf of keyFiles) {
    if (filesRead >= maxFiles) break;
    const fp = path.join(projectDir, kf);
    if (fileExists(fp)) {
      try {
        const content = readFile(fp);
        if (content.length <= maxFileSize) {
          contextParts.push(`# ${kf}\n\`\`\`\n${content}\n\`\`\``);
          filesRead++;
        }
      } catch {
        // skip unreadable files
      }
    }
  }

  return contextParts.join('\n\n');
}
