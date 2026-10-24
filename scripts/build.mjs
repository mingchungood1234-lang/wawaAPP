// Packages the mobile layer as a userscript for phone browsers
// (Firefox for Android + Violentmonkey/Tampermonkey).
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { buildPayload } from './payload.mjs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const header = `// ==UserScript==
// @name         WhatsApp Web Mobile
// @namespace    whatsapp-mobile
// @version      ${version}
// @description  Single-pane, touch-friendly WhatsApp Web layout for phones
// @match        https://web.whatsapp.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
`;

mkdirSync(new URL('../dist/', import.meta.url), { recursive: true });
const out = new URL('../dist/whatsapp-mobile.user.js', import.meta.url);
writeFileSync(out, header + '\n' + buildPayload());
console.log('wrote dist/whatsapp-mobile.user.js');
