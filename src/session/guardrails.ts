import path from 'path';

export interface Guardrail {
  id: string;
  type: 'allow-paths' | 'deny-paths' | 'deny-operations' | 'max-tokens' | 'style' | 'custom';
  value: string | string[] | number;
  description?: string;
}

export interface GuardrailViolation {
  guardrail: Guardrail;
  message: string;
}

/**
 * Converts guardrails into a system prompt suffix that instructs the AI.
 */
export function guardrailsToSystemPrompt(guardrails: Guardrail[]): string {
  if (!guardrails.length) return '';

  const lines: string[] = [
    '',
    '## RULES AND GUARDRAILS (MUST FOLLOW)',
    'You MUST strictly adhere to the following rules in every response:',
  ];

  for (const g of guardrails) {
    switch (g.type) {
      case 'allow-paths':
        lines.push(`- You may ONLY read or modify files within these paths: ${[g.value].flat().join(', ')}`);
        break;
      case 'deny-paths':
        lines.push(`- You MUST NOT read or modify files within these paths: ${[g.value].flat().join(', ')}`);
        break;
      case 'deny-operations':
        lines.push(`- You MUST NOT perform these operations: ${[g.value].flat().join(', ')}`);
        break;
      case 'max-tokens':
        lines.push(`- Limit your responses to at most ${g.value} tokens.`);
        break;
      case 'style':
        lines.push(`- Follow this coding style: ${g.value}`);
        break;
      case 'custom':
        lines.push(`- ${g.value}`);
        break;
    }
  }

  lines.push('Violating any of the above rules is STRICTLY PROHIBITED.');
  return lines.join('\n');
}

/**
 * Validates a proposed file path against guardrails.
 */
export function checkFilePathGuardrails(
  filePath: string,
  guardrails: Guardrail[]
): GuardrailViolation | null {
  const absPath = path.resolve(filePath);

  for (const g of guardrails) {
    if (g.type === 'allow-paths') {
      const allowed = [g.value].flat().map((p) => path.resolve(p as string));
      const isAllowed = allowed.some((a) => absPath.startsWith(a));
      if (!isAllowed) {
        return {
          guardrail: g,
          message: `File path "${filePath}" is not within allowed paths: ${allowed.join(', ')}`,
        };
      }
    }
    if (g.type === 'deny-paths') {
      const denied = [g.value].flat().map((p) => path.resolve(p as string));
      const isDenied = denied.some((d) => absPath.startsWith(d));
      if (isDenied) {
        return {
          guardrail: g,
          message: `File path "${filePath}" is within denied paths: ${denied.join(', ')}`,
        };
      }
    }
  }

  return null;
}

export function createGuardrail(
  type: Guardrail['type'],
  value: string | string[] | number,
  description?: string
): Guardrail {
  return {
    id: `gr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    value,
    description,
  };
}
