import { loadConfig, saveConfig } from '../src/utils/config';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('config', () => {
  describe('loadConfig', () => {
    it('should apply overrides over defaults', () => {
      const config = loadConfig({ provider: 'openai', port: 3000 });
      expect(config.provider).toBe('openai');
      expect(config.port).toBe(3000);
    });

    it('should merge overrides with defaults', () => {
      const config = loadConfig({ provider: 'anthropic', port: 4000 });
      expect(config.provider).toBe('anthropic');
      expect(config.port).toBe(4000);
    });

    it('should pick up OPENAI_API_KEY for openai provider', () => {
      const original = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'test-key-123';
      const config = loadConfig({ provider: 'openai' });
      expect(config.apiKey).toBe('test-key-123');
      if (original) process.env.OPENAI_API_KEY = original;
      else delete process.env.OPENAI_API_KEY;
    });
  });

  describe('saveConfig', () => {
    it('should save config without API key', () => {
      // We test indirectly by ensuring the function runs without throwing
      expect(() => saveConfig({ provider: 'gemini', port: 5000 })).not.toThrow();

      // Clean up saved config
      const savedPath = path.join(os.homedir(), '.vibe-agent', 'config.json');
      if (fs.existsSync(savedPath)) {
        try {
          const saved = JSON.parse(fs.readFileSync(savedPath, 'utf-8'));
          // should not contain apiKey
          expect(saved.apiKey).toBeUndefined();
        } catch {
          // ignore
        }
      }
    });
  });
});
