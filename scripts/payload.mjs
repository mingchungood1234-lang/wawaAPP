import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

// The mobile layer is one self-contained script: src/mobile.js with src/mobile.css
// inlined as __WAM_CSS__. Every target (dev harness, userscript, WebView) injects this.
export function buildPayload() {
  const css = readFileSync(join(SRC_DIR, 'mobile.css'), 'utf8');
  const js = readFileSync(join(SRC_DIR, 'mobile.js'), 'utf8');
  return `(function () {\nconst __WAM_CSS__ = ${JSON.stringify(css)};\n${js}\n})();\n`;
}
