// WhatsApp Web mobile layer.
//
// WhatsApp's class names are obfuscated and change every release, so nothing here
// depends on them. Instead we anchor on the few stable ids (#app, #side, #main),
// find the column layout around them by structure/geometry, and tag those elements
// with our own data-wam-* attributes. mobile.css only targets those tags.
//
// Views:  list (chat list)  ->  chat (#main open)  ->  drawer (contact info, search...)
// Each deeper view pushes a history entry, so the phone's back button/gesture works.

if (window.__wam) window.__wam.destroy();

const CSS = typeof __WAM_CSS__ !== 'undefined' ? __WAM_CSS__ : '';
const MOBILE_QUERY = '(max-width: 820px)';
const LEVEL = { list: 0, chat: 1, drawer: 2 };
const TAGS = ['data-wam-col', 'data-wam-row', 'data-wam-chain'];

const html = document.documentElement;
const media = window.matchMedia(MOBILE_QUERY);
const cleanups = [];

const layout = { row: null, side: null, main: null, drawers: [], tagged: [] };
let view = 'list';
let pushed = 0;        // history entries we've pushed (== level of current view)
let ignorePops = 0;    // popstates caused by our own history.go()
let userClosedChat = null; // the #main element the user backed out of
let scheduled = false;

// ---------- setup ----------

const style = document.createElement('style');
style.id = 'wam-style';
style.textContent = CSS;
(document.head || html).appendChild(style);
cleanups.push(() => style.remove());

ensureViewport();
html.setAttribute('data-wam-view', view);

const backBtn = document.createElement('button');
backBtn.id = 'wam-back';
backBtn.type = 'button';
backBtn.setAttribute('aria-label', 'Back');
backBtn.innerHTML =
  '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>';
backBtn.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  goBack();
});
cleanups.push(() => backBtn.remove());

const observer = new MutationObserver(schedule);
observer.observe(html, { childList: true, subtree: true });
cleanups.push(() => observer.disconnect());

on(media, 'change', schedule);
on(window, 'resize', schedule);
on(window, 'popstate', onPopState);
// Tapping a chat in the list always means "show me that chat", even if it was
// already the open one (WhatsApp won't re-render #main in that case).
on(document, 'click', (e) => {
  if (e.target instanceof Element && e.target.closest('#pane-side [role="row"], #pane-side [role="listitem"]')) {
    userClosedChat = null;
    schedule();
  }
}, true);
// iOS Safari already turns an edge swipe into history.back() (-> popstate), so our own
// swipe would go back twice. In desktop mode iOS reports a Mac UA, hence the touch check.
const isIOS = /iPhone|iPad|Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
if (!isIOS) installSwipeBack();
trackVisualViewport();

update();

// ---------- layout discovery ----------

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    update();
  });
}

function update() {
  const active = media.matches;
  toggleAttr(html, 'data-wam', active);
  if (!active) {
    untag();
    setView('list');
    return;
  }
  if (!layoutValid()) discover();
  // No chat layout yet = login / loading screens, which get the generic fit-to-width rules.
  toggleAttr(html, 'data-wam-ready', !!layout.side);
  if (!layout.side) return;

  if (!backBtn.isConnected) document.body?.appendChild(backBtn);
  setView(computeView());
  positionBackButton();
}

function layoutValid() {
  const side = document.getElementById('side');
  return !!(side && layout.side?.isConnected && layout.side.contains(side) && layout.row?.isConnected);
}

function discover() {
  untag();
  const side = document.getElementById('side');
  const app = document.getElementById('app');
  if (!side || !app) return;

  // Walk up from #side until we hit the column that has the conversation pane as a
  // sibling. That pane sits to the right of the side column and is wide.
  let col = side;
  let row = null;
  while (col.parentElement && col.parentElement !== app) {
    const parent = col.parentElement;
    const r = col.getBoundingClientRect();
    const hasPaneToRight = [...parent.children].some((c) => {
      if (c === col) return false;
      const cr = c.getBoundingClientRect();
      return cr.width > 100 && cr.left >= r.right - 2;
    });
    if (hasPaneToRight) {
      row = parent;
      break;
    }
    col = parent;
  }
  if (!row) return;

  const siblings = [...row.children];
  const sideIdx = siblings.indexOf(col);
  const after = siblings.slice(sideIdx + 1);
  layout.row = row;
  layout.side = col;
  layout.main = after.find((c) => c.querySelector('#main')) || after[0];
  layout.drawers = after.filter((c) => c !== layout.main);

  tag(row, 'data-wam-row', '');
  tag(col, 'data-wam-col', 'side');
  tag(layout.main, 'data-wam-col', 'main');
  layout.drawers.forEach((d) => tag(d, 'data-wam-col', 'drawer'));
  siblings.slice(0, sideIdx).forEach((c) => tag(c, 'data-wam-col', 'rail'));

  // Everything between the row and #app: strip desktop min-widths/gutters, and
  // mark narrow left-hand siblings (the nav rail in newer builds) so the chat
  // view can hide them.
  for (let el = row.parentElement; el && el !== app; el = el.parentElement) {
    tag(el, 'data-wam-chain', '');
  }
  for (let el = row; el && el !== app; el = el.parentElement) {
    const elLeft = el.getBoundingClientRect().left;
    for (const sib of el.parentElement?.children || []) {
      if (sib === el || sib.tagName === 'SCRIPT' || sib.tagName === 'STYLE') continue;
      const sr = sib.getBoundingClientRect();
      if (sr.width > 0 && sr.width < 120 && sr.right <= elLeft + 2) tag(sib, 'data-wam-col', 'rail-outer');
    }
  }
  console.info('[wam] layout tagged', { row, side: col, main: layout.main, drawers: layout.drawers });
}

function tag(el, name, value) {
  if (!el) return;
  el.setAttribute(name, value);
  layout.tagged.push(el);
}

function untag() {
  for (const el of layout.tagged) TAGS.forEach((t) => el.removeAttribute(t));
  Object.assign(layout, { row: null, side: null, main: null, drawers: [], tagged: [] });
}

// ---------- view state ----------

function drawerOpen() {
  // Open drawers always render a header with a close/back icon; closed ones are empty.
  return layout.drawers.some((d) => d.querySelector('[data-icon]'));
}

function computeView() {
  if (drawerOpen()) return 'drawer';
  const main = document.getElementById('main');
  if (main && main !== userClosedChat) return 'chat';
  return 'list';
}

function setView(next) {
  if (next === view) return;
  view = next;
  html.setAttribute('data-wam-view', next);
  if (next === 'list') document.activeElement?.blur?.();
  syncHistory(LEVEL[next]);
}

function syncHistory(level) {
  if (!media.matches) level = 0;
  while (pushed < level) {
    history.pushState({ wam: ++pushed }, '');
  }
  if (pushed > level) {
    // View got shallower without the back button (e.g. WhatsApp's own close X):
    // drop our now-stale entries so the next back press does the right thing.
    ignorePops++;
    history.go(level - pushed);
    pushed = level;
  }
}

function onPopState() {
  if (ignorePops > 0) {
    ignorePops--;
    return;
  }
  if (pushed === 0) return; // not ours: let the browser navigate
  pushed--;
  closeCurrent();
}

function goBack() {
  if (pushed > 0) history.back(); // -> onPopState -> closeCurrent
  else closeCurrent();
}

function closeCurrent() {
  if (view === 'drawer') {
    const drawer = layout.drawers.find((d) => d.querySelector('[data-icon]'));
    const close = drawer?.querySelector(
      '[data-icon="x"], [data-icon="close"], [data-icon="back"], [data-icon="arrow-back"], [data-icon*="back"], [aria-label="Close"], [aria-label="Back"]'
    );
    const target = close?.closest('button, [role="button"]') || close;
    if (target) target.click();
    else pressEscape();
  } else if (view === 'chat') {
    userClosedChat = document.getElementById('main');
    pressEscape(); // WhatsApp closes the open chat on Esc
  }
  schedule();
}

function pressEscape() {
  const init = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
  const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
  target.dispatchEvent(new KeyboardEvent('keydown', init));
  target.dispatchEvent(new KeyboardEvent('keyup', init));
}

// ---------- back button & gestures ----------

function positionBackButton() {
  const header = view === 'chat' ? document.querySelector('#main header') : null;
  if (!header) {
    backBtn.hidden = true;
    return;
  }
  const r = header.getBoundingClientRect();
  backBtn.hidden = false;
  backBtn.style.top = `${r.top}px`;
  backBtn.style.height = `${r.height}px`;
  backBtn.style.color = getComputedStyle(header).color;
}

function installSwipeBack() {
  let start = null;
  on(document, 'touchstart', (e) => {
    const t = e.touches[0];
    start = view !== 'list' && e.touches.length === 1 && t.clientX < 24 ? { x: t.clientX, y: t.clientY } : null;
  }, { passive: true });
  on(document, 'touchend', (e) => {
    if (!start) return;
    const t = e.changedTouches[0];
    if (t.clientX - start.x > 70 && Math.abs(t.clientY - start.y) < 60) goBack();
    start = null;
  }, { passive: true });
}

// Safari ignores interactive-widget=resizes-content: the keyboard overlays the page
// instead of shrinking it. Size #app to the visible area so the composer stays above it.
function trackVisualViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const sync = () => {
    html.style.setProperty('--wam-vh', `${vv.height}px`);
    if (vv.offsetTop > 0 && html.hasAttribute('data-wam-ready')) window.scrollTo(0, 0);
  };
  on(vv, 'resize', sync);
  on(vv, 'scroll', sync);
  cleanups.push(() => html.style.removeProperty('--wam-vh'));
  sync();
}

// ---------- helpers ----------

function ensureViewport() {
  const content = 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content';
  let meta = document.querySelector('meta[name="viewport"]');
  const prev = meta?.getAttribute('content');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'viewport';
    (document.head || html).appendChild(meta);
  }
  meta.setAttribute('content', content);
  cleanups.push(() => (prev == null ? meta.remove() : meta.setAttribute('content', prev)));
}

function toggleAttr(el, name, on) {
  if (on) el.setAttribute(name, '');
  else el.removeAttribute(name);
}

function on(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  cleanups.push(() => target.removeEventListener(type, fn, opts));
}

window.__wam = {
  get view() { return view; },
  layout,
  refresh() { untag(); update(); },
  destroy() {
    untag();
    cleanups.forEach((fn) => fn());
    html.removeAttribute('data-wam');
    html.removeAttribute('data-wam-view');
    html.removeAttribute('data-wam-ready');
    delete window.__wam;
  },
};
