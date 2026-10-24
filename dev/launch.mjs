// Dev harness: WhatsApp Web in Chromium, emulating a phone (viewport, DPR, touch)
// but with a desktop user agent, since WhatsApp Web turns mobile UAs away.
// The mobile layer is injected on every load and hot-reloaded when src/ changes.
//
//   npm run dev                          # Pixel 7, headed, login persisted in .profile/
//   npm run dev -- --device "iPhone 15"
//   npm run dev -- --channel chrome      # use installed Chrome instead of bundled Chromium
//   npm run dev -- --headless --screenshot shot.png
import { chromium, devices } from 'playwright';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildPayload, SRC_DIR } from '../scripts/payload.mjs';

const { values: opts } = parseArgs({
  options: {
    device: { type: 'string', default: 'Pixel 7' },
    channel: { type: 'string' },
    headless: { type: 'boolean', default: false },
    screenshot: { type: 'string' },
    wait: { type: 'string', default: '8' },
    raw: { type: 'boolean', default: false }, // skip the mobile layer, to compare
  },
});

const device = devices[opts.device];
if (!device) {
  console.error(`Unknown device "${opts.device}". Try e.g. "Pixel 7", "iPhone 15", "Galaxy S9+".`);
  process.exit(1);
}

// Desktop UA that matches the real engine version, so WhatsApp doesn't nag about updates.
const probe = await chromium.launch({ channel: opts.channel, headless: true });
const major = probe.version().split('.')[0];
await probe.close();
const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;

const { width, height } = device.viewport;
const context = await chromium.launchPersistentContext(fileURLToPath(new URL('../.profile/', import.meta.url)), {
  channel: opts.channel,
  headless: opts.headless,
  viewport: device.viewport,
  deviceScaleFactor: device.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
  userAgent,
  colorScheme: 'no-preference',
  args: [`--window-size=${width + 40},${height + 140}`],
});

const inject = async (page) => {
  if (opts.raw || !page.url().startsWith('https://web.whatsapp.com')) return;
  try {
    await page.evaluate(buildPayload());
  } catch (err) {
    console.error('[dev] inject failed:', err.message);
  }
};

context.on('page', (page) => page.on('domcontentloaded', () => inject(page)));
const page = context.pages()[0] ?? (await context.newPage());
page.on('domcontentloaded', () => inject(page));
page.on('console', (msg) => msg.text().startsWith('[wam]') && console.log(msg.text()));
await page.goto('https://web.whatsapp.com/');

if (opts.screenshot) {
  await page.waitForTimeout(Number(opts.wait) * 1000);
  await page.screenshot({ path: opts.screenshot });
  console.log(`[dev] saved ${opts.screenshot}`);
  await context.close();
  process.exit(0);
}

let timer;
watch(SRC_DIR, () => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    for (const p of context.pages()) await inject(p);
    console.log('[dev] mobile layer reloaded');
  }, 100);
});

console.log(`[dev] ${opts.device} ${width}x${height} — edit src/ to hot-reload, close the window to quit.`);
context.on('close', () => process.exit(0));
