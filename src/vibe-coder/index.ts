export { AutonomousVibeAgent } from './autonomous-agent';
export { extractFileBlocks, detectCompletion, extractBrowserBlocks, extractAgentBlocks } from './file-parser';
export { LoopDetector, jaccardSimilarity } from './loop-detector';
export type {
  AutonomousConfig,
  VibeCoderRule,
  VibeCoderStep,
  AutonomousStatus,
  HILReason,
  HILRequest,
  VibeCoderFileChange,
  BrowserBlock,
  AgentMessageBlock,
} from './types';
