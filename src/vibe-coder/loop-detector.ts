/**
 * Detects when the AI is generating repetitive responses ("running in circles")
 * by comparing recent responses using word-level Jaccard similarity.
 */
export class LoopDetector {
  private window: string[] = [];
  private readonly windowSize: number;
  private readonly threshold: number;

  constructor(windowSize = 4, threshold = 0.85) {
    this.windowSize = windowSize;
    this.threshold = threshold;
  }

  /**
   * Add a response to the sliding window.
   * Returns `true` if the response is too similar to a previous one (loop detected).
   */
  add(response: string): boolean {
    const normalized = response.trim();
    const isLoop = this.window.some(
      (prev) => jaccardSimilarity(normalized, prev) >= this.threshold
    );
    this.window.push(normalized);
    if (this.window.length > this.windowSize) {
      this.window.shift();
    }
    return isLoop;
  }

  /** Reset the detection window (e.g. after HIL guidance is received). */
  reset(): void {
    this.window = [];
  }
}

/**
 * Compute the Jaccard similarity of two strings at the word level.
 * Returns a value in [0, 1]; 1 means identical word-sets.
 */
export function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set((a.toLowerCase().match(/\b\w+\b/g) ?? []) as string[]);
  const wordsB = new Set((b.toLowerCase().match(/\b\w+\b/g) ?? []) as string[]);
  let intersectionSize = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersectionSize++;
  }
  const unionSize = wordsA.size + wordsB.size - intersectionSize;
  return unionSize === 0 ? 1 : intersectionSize / unionSize;
}
