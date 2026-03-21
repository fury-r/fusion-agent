import { guardrailsToSystemPrompt, checkFilePathGuardrails, createGuardrail } from '../src/session/guardrails';
import path from 'path';

describe('guardrails', () => {
  describe('createGuardrail', () => {
    it('should create a guardrail with a unique id', () => {
      const g = createGuardrail('custom', 'Do not delete files');
      expect(g.id).toMatch(/^gr-/);
      expect(g.type).toBe('custom');
      expect(g.value).toBe('Do not delete files');
    });
  });

  describe('guardrailsToSystemPrompt', () => {
    it('should return empty string for no guardrails', () => {
      expect(guardrailsToSystemPrompt([])).toBe('');
    });

    it('should include allow-paths instruction', () => {
      const g = createGuardrail('allow-paths', ['/src', '/tests']);
      const prompt = guardrailsToSystemPrompt([g]);
      expect(prompt).toContain('ONLY read or modify files');
      expect(prompt).toContain('/src');
    });

    it('should include deny-paths instruction', () => {
      const g = createGuardrail('deny-paths', '/node_modules');
      const prompt = guardrailsToSystemPrompt([g]);
      expect(prompt).toContain('MUST NOT read or modify');
    });

    it('should include max-tokens instruction', () => {
      const g = createGuardrail('max-tokens', 1000);
      const prompt = guardrailsToSystemPrompt([g]);
      expect(prompt).toContain('1000 tokens');
    });

    it('should include custom rule', () => {
      const g = createGuardrail('custom', 'Always use TypeScript');
      const prompt = guardrailsToSystemPrompt([g]);
      expect(prompt).toContain('Always use TypeScript');
    });
  });

  describe('checkFilePathGuardrails', () => {
    it('should return null when no guardrails', () => {
      const result = checkFilePathGuardrails('/any/path', []);
      expect(result).toBeNull();
    });

    it('should return null when path is within allow-paths', () => {
      const g = createGuardrail('allow-paths', [process.cwd()]);
      const result = checkFilePathGuardrails(path.join(process.cwd(), 'src/test.ts'), [g]);
      expect(result).toBeNull();
    });

    it('should return violation when path is outside allow-paths', () => {
      const g = createGuardrail('allow-paths', ['/restricted/dir']);
      const result = checkFilePathGuardrails('/other/dir/file.ts', [g]);
      expect(result).not.toBeNull();
      expect(result?.message).toContain('not within allowed paths');
    });

    it('should return violation when path matches deny-paths', () => {
      const deniedDir = '/home/user/secrets';
      const g = createGuardrail('deny-paths', deniedDir);
      const result = checkFilePathGuardrails(`${deniedDir}/config.env`, [g]);
      expect(result).not.toBeNull();
      expect(result?.message).toContain('denied paths');
    });

    it('should return null when path is not in deny-paths', () => {
      const g = createGuardrail('deny-paths', '/secrets');
      const result = checkFilePathGuardrails('/src/code.ts', [g]);
      expect(result).toBeNull();
    });
  });
});
