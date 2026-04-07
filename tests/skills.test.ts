import fs from 'fs';
import path from 'path';
import os from 'os';

// Override the skills directory to a temp location for testing
const TEST_SKILLS_DIR = path.join(os.tmpdir(), `fusion-agent-test-skills-${process.pid}`);

// Patch the module before importing
jest.mock('path', () => {
  const actual = jest.requireActual<typeof import('path')>('path');
  return {
    ...actual,
    join: (...args: string[]) => {
      if (args[0] === os.homedir() && args[1] === '.fusion-agent' && args[2] === 'skills') {
        return TEST_SKILLS_DIR;
      }
      return actual.join(...args);
    },
  };
});

import {
  listSkills,
  loadSkill,
  loadSkillsContent,
} from '../src/skills/registry';

function writeSkill(name: string, content: string): void {
  const dir = path.join(TEST_SKILLS_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf-8');
}

beforeAll(() => {
  fs.mkdirSync(TEST_SKILLS_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TEST_SKILLS_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  // Clear skills dir between tests
  for (const entry of fs.readdirSync(TEST_SKILLS_DIR)) {
    fs.rmSync(path.join(TEST_SKILLS_DIR, entry), { recursive: true, force: true });
  }
});

// ── listSkills ────────────────────────────────────────────────────────────────

describe('listSkills', () => {
  it('returns empty array when no skills are installed', () => {
    expect(listSkills()).toEqual([]);
  });

  it('returns installed skill names', () => {
    writeSkill('react-expert', '# React Expert\nYou are a React specialist.');
    writeSkill('rust-guru', '# Rust Guru\nYou are a Rust expert.');

    const skills = listSkills();
    expect(skills).toHaveLength(2);
    expect(skills).toContain('react-expert');
    expect(skills).toContain('rust-guru');
  });

  it('ignores files (only directories are skills)', () => {
    writeSkill('valid-skill', '# Valid');
    fs.writeFileSync(path.join(TEST_SKILLS_DIR, 'not-a-skill.txt'), 'hello');
    const skills = listSkills();
    expect(skills).toHaveLength(1);
    expect(skills).toContain('valid-skill');
  });
});

// ── loadSkill ─────────────────────────────────────────────────────────────────

describe('loadSkill', () => {
  it('returns null for unknown skill', () => {
    expect(loadSkill('nonexistent')).toBeNull();
  });

  it('loads a skill by name', () => {
    writeSkill('my-skill', '# My Skill\nBe helpful.');
    const skill = loadSkill('my-skill');
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('my-skill');
    expect(skill!.content).toContain('Be helpful.');
    expect(skill!.filePath).toContain('my-skill');
  });

  it('returns null when SKILL.md is missing inside the directory', () => {
    fs.mkdirSync(path.join(TEST_SKILLS_DIR, 'empty-skill'), { recursive: true });
    expect(loadSkill('empty-skill')).toBeNull();
  });
});

// ── loadSkillsContent ─────────────────────────────────────────────────────────

describe('loadSkillsContent', () => {
  it('returns empty string when skills array is empty', () => {
    expect(loadSkillsContent([])).toBe('');
  });

  it('returns empty string when all skill names are unknown', () => {
    expect(loadSkillsContent(['no-such-skill'])).toBe('');
  });

  it('concatenates content from multiple skills', () => {
    writeSkill('skill-a', '# Skill A\nContent A.');
    writeSkill('skill-b', '# Skill B\nContent B.');
    const result = loadSkillsContent(['skill-a', 'skill-b']);
    expect(result).toContain('Content A.');
    expect(result).toContain('Content B.');
  });

  it('silently skips unknown skill names', () => {
    writeSkill('real-skill', '# Real\nReal content.');
    const result = loadSkillsContent(['real-skill', 'ghost-skill']);
    expect(result).toContain('Real content.');
    expect(result).not.toContain('ghost-skill');
  });
});
