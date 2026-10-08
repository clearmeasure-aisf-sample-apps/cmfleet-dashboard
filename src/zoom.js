// Zooming from the fleet into one system and back out. A click on a system loads its dashboard in a frame that starts
// exactly over what was clicked and grows to the whole screen while the fleet scales up around that spot and fades:
// from high above, into the box. The reader stays in the fleet's page: "Fleet", Escape and the browser's Back zoom out.
const byId = (id) => document.getElementById(id);
const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const DURATION = 800;
const EASING = 'cubic-bezier(.6, 0, .2, 1)';

let find = () => null;
let open = '';

// Where a rectangle of the page is on the screen, as the transform that puts the whole screen there.
function into(rect) {
  const width = Math.max(rect.width, 1) / window.innerWidth;
  const height = Math.max(rect.height, 1) / window.innerHeight;
  return `translate(${rect.left}px, ${rect.top}px) scale(${width}, ${height})`;
}

// The element a system zooms out of and back into: its box in the landscape when that is on the screen, else its tile.
function origin(slug) {
  const candidates = [...document.querySelectorAll(`[data-zoom="${CSS.escape(slug)}"]`)];
  const seen = candidates.find((one) => {
    const rect = one.getBoundingClientRect();
    return rect.width > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
  });
  return seen || candidates[0] || null;
}

function play(element, frames, backwards) {
  if (still()) return Promise.resolve();
  const animation = element.animate(frames, { duration: DURATION, easing: EASING, direction: backwards ? 'reverse' : 'normal', fill: 'both' });
  return animation.finished.then(() => animation.cancel(), () => {});
}

// The fleet scales up around the spot that was clicked, and fades.
function wallFrames(rect) {
  const wall = document.querySelector('.wall').getBoundingClientRect();
  const scale = Math.min(12, Math.max(window.innerWidth / Math.max(rect.width, 1), window.innerHeight / Math.max(rect.height, 1)));
  const at = `${rect.left + rect.width / 2 - wall.left}px ${rect.top + rect.height / 2 - wall.top}px`;
  return [{ transformOrigin: at, transform: 'scale(1)', opacity: 1 }, { transformOrigin: at, transform: `scale(${scale})`, opacity: 0 }];
}

async function zoomIn(slug, animate) {
  const system = find(slug);
  if (!system || open === slug) return;
  const from = origin(slug);
  const rect = from ? from.getBoundingClientRect() : new DOMRect(window.innerWidth / 2, window.innerHeight / 2, 1, 1);
  const layer = byId('zoom');
  byId('zoom-name').textContent = system.name;
  byId('zoom-own').href = system.url;
  // A frame of its own for every zoom, with its address set before it is in the page: the browser then keeps no entry
  // of it in the tab's history, and Back leaves the system instead of stepping through frames that are gone.
  const frame = document.createElement('iframe');
  frame.id = 'zoom-frame';
  frame.title = `The dashboard of ${system.name}`;
  frame.referrerPolicy = 'no-referrer';
  frame.src = system.url;
  byId('zoom-stage').replaceChildren(frame);
  layer.hidden = false;
  open = slug;
  if (animate) {
    await Promise.all([
      play(layer, [{ transform: into(rect), opacity: 0.35 }, { transform: 'none', opacity: 1 }], false),
      play(document.querySelector('.wall'), wallFrames(rect), false),
    ]);
  }
  document.body.dataset.zoomed = slug;
  byId('zoom-out').focus({ preventScroll: true });
}

async function zoomOut(animate) {
  if (!open) return;
  const slug = open;
  const layer = byId('zoom');
  open = '';
  delete document.body.dataset.zoomed;
  const from = origin(slug);
  if (animate && from) {
    const rect = from.getBoundingClientRect();
    await Promise.all([
      play(layer, [{ transform: into(rect), opacity: 0.35 }, { transform: 'none', opacity: 1 }], true),
      play(document.querySelector('.wall'), wallFrames(rect), true),
    ]);
  }
  layer.hidden = true;
  byId('zoom-stage').replaceChildren();
}

// The address says which system is open: #cmdemo2. Back and Forward change it, and the page follows.
function follow(animate) {
  const slug = decodeURIComponent(window.location.hash.slice(1));
  if (slug && find(slug)) return zoomIn(slug, animate);
  return zoomOut(animate);
}

function clicked(event) {
  // A click that asks for a new tab or window is the browser's to answer.
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target.closest?.('[data-zoom]');
  if (!link || !find(link.dataset.zoom)) return;
  event.preventDefault();
  window.history.pushState(null, '', `#${encodeURIComponent(link.dataset.zoom)}`);
  zoomIn(link.dataset.zoom, true);
}

function out() {
  if (!open) return;
  window.history.pushState(null, '', window.location.pathname + window.location.search);
  zoomOut(true);
}

// find(slug) answers { name, url } for a system that has something to zoom into, and nothing for one that has not.
export function initZoom(lookup) {
  find = lookup;
  document.addEventListener('click', clicked);
  byId('zoom-out').addEventListener('click', out);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') out(); });
  window.addEventListener('popstate', () => follow(true));
}

// After the fleet's data is drawn for the first time: an address that names a system opens it, without the animation.
export function openFromAddress() {
  return follow(false);
}
