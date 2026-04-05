import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import { logger } from '../utils/logger';

export interface SkillMeta {
  name: string;
  /** Path to the SKILL.md file on disk */
  filePath: string;
  /** Content of SKILL.md */
  content: string;
}

const SKILLS_DIR = path.join(os.homedir(), '.fusion-agent', 'skills');

/** Ensure the skills directory exists. */
function ensureSkillsDir(): void {
  if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
  }
}

/**
 * List all installed skill names (directory names under ~/.fusion-agent/skills/).
 */
export function listSkills(): string[] {
  ensureSkillsDir();
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

/**
 * Load a skill by name from ~/.fusion-agent/skills/<name>/SKILL.md.
 * Returns null if the skill is not found.
 */
export function loadSkill(name: string): SkillMeta | null {
  ensureSkillsDir();
  const skillFile = path.join(SKILLS_DIR, name, 'SKILL.md');
  if (!fs.existsSync(skillFile)) {
    logger.warn(`Skill "${name}" not found at ${skillFile}`);
    return null;
  }
  const content = fs.readFileSync(skillFile, 'utf-8');
  return { name, filePath: skillFile, content };
}

/**
 * Fetch a skill from a remote URL and cache it locally.
 * The URL should return raw Markdown (SKILL.md content).
 * Subsequent calls use the cached version unless `force` is true.
 */
export async function loadRemoteSkill(
  name: string,
  url: string,
  force = false
): Promise<SkillMeta> {
  ensureSkillsDir();
  const skillDir = path.join(SKILLS_DIR, name);
  const skillFile = path.join(skillDir, 'SKILL.md');

  if (!force && fs.existsSync(skillFile)) {
    // Use cached version
    const content = fs.readFileSync(skillFile, 'utf-8');
    return { name, filePath: skillFile, content };
  }

  logger.info(`Fetching remote skill "${name}" from ${url}`);
  const response = await axios.get<string>(url, { responseType: 'text', timeout: 10_000 });
  const content = response.data;

  if (!fs.existsSync(skillDir)) {
    fs.mkdirSync(skillDir, { recursive: true });
  }
  fs.writeFileSync(skillFile, content, 'utf-8');
  logger.info(`Skill "${name}" cached at ${skillFile}`);
  return { name, filePath: skillFile, content };
}

/**
 * Load multiple skills by name, returning their combined content as a single
 * string suitable for injection into a system prompt.
 */
export function loadSkillsContent(names: string[]): string {
  const sections: string[] = [];
  for (const name of names) {
    const skill = loadSkill(name);
    if (skill) {
      sections.push(`## Skill: ${skill.name}\n\n${skill.content}`);
    }
  }
  return sections.join('\n\n---\n\n');
}

/** Full path to the skills directory. */
export function skillsDir(): string {
  return SKILLS_DIR;
}
