import fs from 'fs';
import puppeteer, { Browser, Page } from 'puppeteer-core';
import { logger } from '../utils/logger';

/** Result of a browser action. */
export interface BrowserActionResult {
  action: string;
  success: boolean;
  /** Text or base64 data returned by the action (e.g. page title, eval result, snapshot text). */
  data?: string;
  error?: string;
}

const COMMON_CHROME_PATHS: Record<NodeJS.Platform, string[]> = {
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
  aix: [],
  android: [],
  cygwin: [],
  freebsd: [],
  haiku: [],
  netbsd: [],
  openbsd: [],
  sunos: [],
};

function resolveExecutablePath(override?: string): string {
  if (override) return override;
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates =
    (COMMON_CHROME_PATHS[process.platform as NodeJS.Platform] ?? []);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    'Could not find Chrome/Chromium. Set CHROME_PATH env variable or pass browserExecutablePath in config.'
  );
}

export class BrowserController {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private readonly executablePath: string;

  constructor(executablePathOverride?: string) {
    this.executablePath = resolveExecutablePath(executablePathOverride);
  }

  private async ensureBrowser(): Promise<Page> {
    if (!this.browser || !this.browser.connected) {
      this.browser = await puppeteer.launch({
        executablePath: this.executablePath,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
    }
    if (!this.page || this.page.isClosed()) {
      this.page = await this.browser.newPage();
    }
    return this.page;
  }

  /**
   * Execute a list of instruction strings (as produced by extractBrowserBlocks).
   * Returns one BrowserActionResult per instruction.
   */
  async execute(instructions: string[]): Promise<BrowserActionResult[]> {
    const results: BrowserActionResult[] = [];
    for (const instruction of instructions) {
      results.push(await this.executeOne(instruction));
    }
    return results;
  }

  private async executeOne(instruction: string): Promise<BrowserActionResult> {
    const lower = instruction.toLowerCase();
    try {
      if (lower.startsWith('navigate ')) {
        const url = instruction.slice('navigate '.length).trim();
        return await this.navigate(url);
      } else if (lower === 'snapshot') {
        return await this.snapshot();
      } else if (lower.startsWith('click ')) {
        const selector = instruction.slice('click '.length).trim();
        return await this.click(selector);
      } else if (lower.startsWith('type ')) {
        // format: type <selector> <text…>
        const rest = instruction.slice('type '.length).trim();
        const spaceIdx = rest.indexOf(' ');
        if (spaceIdx === -1) {
          return { action: instruction, success: false, error: 'type requires: <selector> <text>' };
        }
        const selector = rest.slice(0, spaceIdx);
        const text = rest.slice(spaceIdx + 1);
        return await this.typeText(selector, text);
      } else if (lower.startsWith('eval ')) {
        const js = instruction.slice('eval '.length).trim();
        return await this.evaluate(js);
      } else {
        return { action: instruction, success: false, error: `Unknown browser instruction: ${instruction}` };
      }
    } catch (err) {
      return { action: instruction, success: false, error: String(err) };
    }
  }

  async navigate(url: string): Promise<BrowserActionResult> {
    const page = await this.ensureBrowser();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 });
    const title = await page.title();
    logger.debug(`Browser navigated to ${url} — title: "${title}"`);
    return { action: `navigate ${url}`, success: true, data: `Navigated to ${url} (title: "${title}")` };
  }

  async snapshot(): Promise<BrowserActionResult> {
    const page = await this.ensureBrowser();
    const text = (await page.evaluate('document.body.innerText')) as string;
    const url = page.url();
    const title = await page.title();
    const summary = `URL: ${url}\nTitle: ${title}\n\nPage text (first 2000 chars):\n${text.slice(0, 2000)}`;
    return { action: 'snapshot', success: true, data: summary };
  }

  async click(selector: string): Promise<BrowserActionResult> {
    const page = await this.ensureBrowser();
    await page.click(selector);
    return { action: `click ${selector}`, success: true, data: `Clicked "${selector}"` };
  }

  async typeText(selector: string, text: string): Promise<BrowserActionResult> {
    const page = await this.ensureBrowser();
    await page.focus(selector);
    await page.type(selector, text);
    return { action: `type ${selector} ${text}`, success: true, data: `Typed into "${selector}"` };
  }

  async evaluate(js: string): Promise<BrowserActionResult> {
    const page = await this.ensureBrowser();
    const result = await page.evaluate(js);
    return { action: `eval ${js}`, success: true, data: String(result) };
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }
}
