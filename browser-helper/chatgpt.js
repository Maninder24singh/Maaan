// Opens ChatGPT, types your message in the chat box, presses Enter, prints the reply.
// Usage:  node chatgpt.js --login            (one time: log in by hand)
//         node chatgpt.js "your message"
const { chromium } = require('playwright');
const os = require('os');
const path = require('path');

const PROFILE = path.join(os.homedir(), 'chatgpt-profile'); // its own folder, not your Chrome
const args = process.argv.slice(2);
const login = args[0] === '--login';
const message = args.join(' ').trim();

if (!login && !message) {
  console.log('Usage:\n  ./chatgpt --login\n  ./chatgpt "your message"');
  process.exit(1);
}

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, viewport: null });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://chatgpt.com/');

  if (login) {
    console.log('Log in to ChatGPT in the window. Then close the window.');
    await new Promise((resolve) => ctx.on('close', resolve));
    return;
  }

  const box = page.locator('#prompt-textarea');
  try {
    await box.waitFor({ timeout: 30000 });
  } catch {
    console.log('Chat box not found. Not logged in, or a "verify you are human" check is showing.');
    console.log('Fix it in the window, or run: ./chatgpt --login');
    await ctx.close();
    process.exit(1);
  }

  await box.click();
  await page.keyboard.type(message, { delay: 30 });
  await page.keyboard.press('Enter');

  // wait for the answer to start, then to finish
  const replies = page.locator('[data-message-author-role="assistant"]');
  await replies.last().waitFor({ timeout: 60000 });
  const stop = page.locator('[data-testid="stop-button"]');
  await stop.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  await stop.waitFor({ state: 'hidden', timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(1000);

  console.log('\n--- ChatGPT says ---\n' + (await replies.last().innerText()));
  await ctx.close();
})();
