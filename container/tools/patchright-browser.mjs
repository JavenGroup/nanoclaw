#!/usr/bin/env node
/**
 * Patchright Browser Tool
 * Anti-detection browser automation using Patchright (undetected Playwright fork).
 *
 * Usage:
 *   patchright-browser open <url>           Open URL in headed Chromium
 *   patchright-browser screenshot <url>     Take screenshot, save to /tmp/screenshot.png
 *   patchright-browser html <url>           Print page HTML
 *   patchright-browser text <url>           Print visible text
 *   patchright-browser click <selector>     Click element (requires open page)
 *   patchright-browser type <selector> <text>  Type into element
 *   patchright-browser eval <js>            Evaluate JavaScript on current page
 *   patchright-browser close                Close browser
 *   patchright-browser status               Show browser status
 */

import { chromium } from 'patchright';
import fs from 'fs';
import path from 'path';

const STATE_FILE = '/tmp/patchright-state.json';
const SCREENSHOT_DIR = '/tmp';

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch {}
  return null;
}

function saveState(wsEndpoint, pid) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ wsEndpoint, pid }));
}

function clearState() {
  try { fs.unlinkSync(STATE_FILE); } catch {}
}

async function getBrowser() {
  const state = loadState();
  if (!state) return null;
  try {
    return await chromium.connectOverCDP(state.wsEndpoint);
  } catch {
    clearState();
    return null;
  }
}

async function launchBrowser() {
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  // Get CDP endpoint for reconnection
  const wsEndpoint = browser.contexts()[0]?.pages()[0]?.url() || '';
  // Save PID-like info for reconnection
  const cdpUrl = `http://127.0.0.1:${browser._initializer?.connectedBrowser?.pid || 0}`;

  return browser;
}

async function ensureBrowser(url) {
  let browser = await getBrowser();
  if (!browser) {
    browser = await chromium.launch({
      headless: false,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
  }

  let context = browser.contexts()[0];
  if (!context) {
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });
  }

  let page = context.pages()[0];
  if (!page) {
    page = await context.newPage();
  }

  if (url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  return { browser, context, page };
}

const [,, command, ...args] = process.argv;

try {
  switch (command) {
    case 'open': {
      const url = args[0];
      if (!url) { console.error('Usage: patchright-browser open <url>'); process.exit(1); }
      const { page } = await ensureBrowser(url);
      const title = await page.title();
      console.log(`Opened: ${url}`);
      console.log(`Title: ${title}`);
      // Keep browser running — don't close
      // Disconnect without closing
      break;
    }

    case 'screenshot': {
      const url = args[0];
      const { page } = await ensureBrowser(url);
      if (url) await page.waitForTimeout(2000); // Wait for render
      const filePath = path.join(SCREENSHOT_DIR, `screenshot-${Date.now()}.png`);
      await page.screenshot({ path: filePath, fullPage: false });
      console.log(`Screenshot saved: ${filePath}`);
      break;
    }

    case 'html': {
      const url = args[0];
      const { page } = await ensureBrowser(url);
      const html = await page.content();
      console.log(html);
      break;
    }

    case 'text': {
      const url = args[0];
      const { page } = await ensureBrowser(url);
      const text = await page.evaluate(() => document.body.innerText);
      console.log(text);
      break;
    }

    case 'click': {
      const selector = args[0];
      if (!selector) { console.error('Usage: patchright-browser click <selector>'); process.exit(1); }
      const { page } = await ensureBrowser();
      await page.click(selector, { timeout: 10000 });
      console.log(`Clicked: ${selector}`);
      break;
    }

    case 'type': {
      const selector = args[0];
      const text = args.slice(1).join(' ');
      if (!selector || !text) { console.error('Usage: patchright-browser type <selector> <text>'); process.exit(1); }
      const { page } = await ensureBrowser();
      await page.fill(selector, text, { timeout: 10000 });
      console.log(`Typed into ${selector}: ${text}`);
      break;
    }

    case 'eval': {
      const js = args.join(' ');
      if (!js) { console.error('Usage: patchright-browser eval <javascript>'); process.exit(1); }
      const { page } = await ensureBrowser();
      const result = await page.evaluate(js);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'close': {
      const browser = await getBrowser();
      if (browser) {
        await browser.close();
        clearState();
        console.log('Browser closed.');
      } else {
        console.log('No browser running.');
      }
      break;
    }

    case 'status': {
      const state = loadState();
      if (state) {
        const browser = await getBrowser();
        if (browser) {
          const pages = browser.contexts().flatMap(c => c.pages());
          console.log(`Browser running. Pages: ${pages.length}`);
          for (const p of pages) {
            console.log(`  - ${await p.title()} (${p.url()})`);
          }
        } else {
          console.log('Browser state exists but not reachable.');
        }
      } else {
        console.log('No browser running.');
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error('Commands: open, screenshot, html, text, click, type, eval, close, status');
      process.exit(1);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
