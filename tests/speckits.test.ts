import { listSpeckits, getSpeckit, SPECKITS } from '../src/speckits';

describe('speckits', () => {
  describe('listSpeckits', () => {
    it('should return all built-in speckits', () => {
      const speckits = listSpeckits();
      expect(speckits.length).toBeGreaterThanOrEqual(7);
      const names = speckits.map((s) => s.name);
      expect(names).toContain('vibe-coder');
      expect(names).toContain('debugger');
      expect(names).toContain('code-review');
      expect(names).toContain('doc-writer');
      expect(names).toContain('test-writer');
      expect(names).toContain('refactor');
      expect(names).toContain('security-audit');
    });
  });

  describe('getSpeckit', () => {
    it('should return the correct speckit by name', () => {
      const sk = getSpeckit('vibe-coder');
      expect(sk).toBeDefined();
      expect(sk?.name).toBe('vibe-coder');
      expect(sk?.systemPrompt).toContain('pair programmer');
    });

    it('should return undefined for unknown speckit', () => {
      expect(getSpeckit('nonexistent')).toBeUndefined();
    });
  });

  describe('speckit structure', () => {
    it('each speckit should have name, description, and systemPrompt', () => {
      for (const sk of Object.values(SPECKITS)) {
        expect(typeof sk.name).toBe('string');
        expect(sk.name.length).toBeGreaterThan(0);
        expect(typeof sk.description).toBe('string');
        expect(sk.description.length).toBeGreaterThan(0);
        expect(typeof sk.systemPrompt).toBe('string');
        expect(sk.systemPrompt.length).toBeGreaterThan(0);
      }
    });
  });
});
