// Small DOM helpers.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'vars') for (const [n, val] of Object.entries(v)) el.style.setProperty(n, val);
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
}

export function svg(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstChild;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// Anchored popover menu; closes on outside click or Escape.
let openMenu = null;
export function closeMenu() {
  if (openMenu) {
    openMenu.anchor.setAttribute('aria-expanded', 'false');
    openMenu.el.remove();
    openMenu = null;
  }
}

export function showMenu(anchor, title, items) {
  const again = openMenu && openMenu.anchor === anchor;
  closeMenu();
  if (again) return;
  const stacked = items.some((it) => it.note && it.note.length > 26);
  const el = h(
    'div',
    { class: 'menu' + (stacked ? ' menu-stack' : ''), role: 'menu' },
    title ? h('div', { class: 'menu-title' }, title) : null,
    items.map((it) =>
      h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          disabled: it.disabled || false,
          onclick: () => {
            closeMenu();
            it.run();
          },
        },
        h('span', null, it.label),
        it.note ? h('small', null, it.note) : null,
      ),
    ),
  );
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const mw = el.offsetWidth;
  const left = Math.max(16, Math.min(window.innerWidth - mw - 16, r.left + window.scrollX));
  let top = r.bottom + window.scrollY + 6;
  if (r.bottom + el.offsetHeight + 90 > window.innerHeight) top = r.top + window.scrollY - el.offsetHeight - 6;
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  anchor.setAttribute('aria-expanded', 'true');
  openMenu = { el, anchor };
  el.querySelector('button:not(:disabled)')?.focus();
}

document.addEventListener('pointerdown', (e) => {
  if (openMenu && !openMenu.el.contains(e.target) && !openMenu.anchor.contains(e.target)) closeMenu();
});
