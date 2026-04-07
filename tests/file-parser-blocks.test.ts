import { extractBrowserBlocks, extractAgentBlocks } from '../src/vibe-coder/file-parser';

// ── extractBrowserBlocks ──────────────────────────────────────────────────────

describe('extractBrowserBlocks', () => {
  it('returns empty array when no browser blocks are present', () => {
    expect(extractBrowserBlocks('No blocks here.')).toEqual([]);
  });

  it('parses a single browser block with one instruction', () => {
    const text = '<browser>\nnavigate https://example.com\n</browser>';
    const result = extractBrowserBlocks(text);
    expect(result).toHaveLength(1);
    expect(result[0].instructions).toEqual(['navigate https://example.com']);
  });

  it('parses multiple instructions in one block', () => {
    const text = '<browser>\nnavigate https://example.com\nsnapshot\nclick #submit\n</browser>';
    const result = extractBrowserBlocks(text);
    expect(result).toHaveLength(1);
    expect(result[0].instructions).toEqual([
      'navigate https://example.com',
      'snapshot',
      'click #submit',
    ]);
  });

  it('parses multiple browser blocks', () => {
    const text = [
      '<browser>navigate https://a.com\nsnapshot</browser>',
      'some prose',
      '<browser>navigate https://b.com\nclick .btn</browser>',
    ].join('\n');
    const result = extractBrowserBlocks(text);
    expect(result).toHaveLength(2);
    expect(result[0].instructions[0]).toBe('navigate https://a.com');
    expect(result[1].instructions[0]).toBe('navigate https://b.com');
  });

  it('skips blocks that contain only whitespace', () => {
    expect(extractBrowserBlocks('<browser>   \n  \n</browser>')).toHaveLength(0);
  });

  it('strips leading/trailing whitespace from each instruction', () => {
    const text = '<browser>\n  navigate https://x.com  \n  snapshot  \n</browser>';
    const result = extractBrowserBlocks(text);
    expect(result[0].instructions).toEqual(['navigate https://x.com', 'snapshot']);
  });

  it('is case-insensitive for the <browser> tag', () => {
    const text = '<BROWSER>\nnavigate https://upper.com\n</BROWSER>';
    const result = extractBrowserBlocks(text);
    expect(result).toHaveLength(1);
  });
});

// ── extractAgentBlocks ────────────────────────────────────────────────────────

describe('extractAgentBlocks', () => {
  it('returns empty array when no agent blocks are present', () => {
    expect(extractAgentBlocks('Nothing here.')).toEqual([]);
  });

  it('parses a single agent block', () => {
    const text = '<agent>send to:session-abc message:Please review the auth module</agent>';
    const result = extractAgentBlocks(text);
    expect(result).toHaveLength(1);
    expect(result[0].toSessionId).toBe('session-abc');
    expect(result[0].message).toBe('Please review the auth module');
  });

  it('parses multiple agent blocks', () => {
    const text = [
      '<agent>send to:agent-1 message:Hello agent one</agent>',
      'some prose',
      '<agent>send to:agent-2 message:Hello agent two</agent>',
    ].join('\n');
    const result = extractAgentBlocks(text);
    expect(result).toHaveLength(2);
    expect(result[0].toSessionId).toBe('agent-1');
    expect(result[1].toSessionId).toBe('agent-2');
  });

  it('trims whitespace from message text', () => {
    const text = '<agent>send to:my-session message:  trimmed message  </agent>';
    const result = extractAgentBlocks(text);
    expect(result).toHaveLength(1);
    expect(result[0].toSessionId).toBe('my-session');
    expect(result[0].message).toBe('trimmed message');
  });

  it('skips blocks with empty message', () => {
    const text = '<agent>send to:session-x message:</agent>';
    expect(extractAgentBlocks(text)).toHaveLength(0);
  });

  it('is case-insensitive for the <agent> tag', () => {
    const text = '<AGENT>send to:id-1 message:Hello</AGENT>';
    const result = extractAgentBlocks(text);
    expect(result).toHaveLength(1);
  });
});
