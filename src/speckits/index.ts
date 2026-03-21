import { Speckit } from './base';
import { vibeCoder } from './vibe-coder';
import { debugger_ } from './debugger';
import { codeReview } from './code-review';
import { docWriter, testWriter, refactor, securityAudit } from './more-speckits';
import { clusterDebugger } from './cluster-debugger';

export const SPECKITS: Record<string, Speckit> = {
  'vibe-coder': vibeCoder,
  'debugger': debugger_,
  'code-review': codeReview,
  'doc-writer': docWriter,
  'test-writer': testWriter,
  'refactor': refactor,
  'security-audit': securityAudit,
  'cluster-debugger': clusterDebugger,
};

export function getSpeckit(name: string): Speckit | undefined {
  return SPECKITS[name];
}

export function listSpeckits(): Speckit[] {
  return Object.values(SPECKITS);
}

export { Speckit } from './base';
export { vibeCoder } from './vibe-coder';
export { debugger_ as debuggerSpeckit } from './debugger';
export { codeReview } from './code-review';
export { docWriter, testWriter, refactor, securityAudit } from './more-speckits';
export { clusterDebugger } from './cluster-debugger';
