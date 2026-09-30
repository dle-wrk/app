/* Tracklab IM docs — shared chrome for every page under /docs/.
   Renders the top nav, the page's "On this page" sidebar, the prev/next
   pager, the landing-page tiles and the cross-page search, all from the
   PAGES list below. To add a page: create its .html (copy any topic page
   as a template) and add one entry here. */
(() => {
  'use strict';

  const PAGES = [
    { slug: 'getting-started',    nav: 'Getting started', title: 'Getting Started',          icon: '🚀', blurb: 'First login, the interface, the dashboard and faster navigation.' },
    { slug: 'inventory',          nav: 'Inventory',       title: 'Inventory & Stock',        icon: '📦', blurb: 'Items, stock levels, Add SKU, imports, item detail and stock tables.' },
    { slug: 'suppliers-pricing',  nav: 'Suppliers',       title: 'Suppliers & Pricing',      icon: '🏭', blurb: 'Supplier records, live price lookup, bulk pricing and the price directory.' },
    { slug: 'manufacturing',      nav: 'Manufacturing',   title: 'Manufacturing & Projects', icon: '🔧', blurb: 'BOMs, production kits, pick & place, alternates, projects and supplier BOMs.' },
    { slug: 'sales',              nav: 'Sales',           title: 'Sales',                    icon: '🧾', blurb: 'Customers, quotations, sales orders, VAT on quotes, invoices and credit notes.' },
    { slug: 'purchases',          nav: 'Purchases',       title: 'Purchases',                icon: '🛒', blurb: 'Vendors, purchase orders, bills and landed cost.' },
    { slug: 'accounting',         nav: 'Accounting',      title: 'Accounting & Reports',     icon: '📊', blurb: 'Payments, bank reconciliation, VAT201 and financial reports.' },
    { slug: 'automation-quality', nav: 'Automation',      title: 'Automation & Quality',     icon: '⚡', blurb: 'Automation rules, auto-PO, scheduled jobs, QA inspections, defects and NCRs.' },
    { slug: 'admin-tips',         nav: 'Admin',           title: 'Admin & Pro Tips',         icon: '🛡️', blurb: 'Accounts and devices, API keys, routines, best practices and troubleshooting.' },
    { slug: 'release-notes',      nav: "What's new",      title: 'Release Notes',            icon: '🆕', blurb: 'Everything that changed in v2.8, v2.7 and v2.6.' },
  ].map((p) => ({ ...p, file: `${p.slug}.html` }));

  const current = document.body.dataset.page || 'index';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const slugify = (s) => String(s).toLowerCase().replace(/&/g, ' and ')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  // Pages ship with ids on every section and h3; this only fills in ids
  // for headings added by hand later, so anchors and search keep working.
  const ensureIds = (root) => {
    const used = new Set($$('[id]', root).map((e) => e.id));
    const claim = (text) => {
      const base = slugify(text) || 'section';
      let id = base;
      let n = 2;
      while (used.has(id)) id = `${base}-${n++}`;
      used.add(id);
      return id;
    };
    $$('.main-col .section', root).forEach((sec) => {
      const h2 = $(':scope > h2', sec);
      if (!sec.id) sec.id = claim(h2 ? h2.textContent : 'section');
      $$(':scope > h3', sec).forEach((h3) => { if (!h3.id) h3.id = claim(h3.textContent); });
    });
  };

  const renderNav = () => {
    const nav = $('#docs-nav');
    if (!nav) return;
    const link = (href, label, isActive) =>
      `<a href="${href}"${isActive ? ' class="active" aria-current="page"' : ''}>${escapeHtml(label)}</a>`;
    nav.innerHTML = `
      <div class="docs-nav-bar">
        <div class="docs-nav-links">
          ${link('index.html', 'All docs', current === 'index')}
          ${PAGES.map((p) => link(p.file, p.nav, p.slug === current)).join('')}
        </div>
        <div class="docs-search" role="search">
          <input id="docs-search-input" type="search" placeholder="Search all docs…  ( / )"
                 autocomplete="off" spellcheck="false" aria-label="Search all docs"
                 aria-controls="docs-search-results" aria-expanded="false">
          <div class="docs-search-results" id="docs-search-results" role="listbox"></div>
        </div>
      </div>`;
    const row = $('.docs-nav-links', nav);
    if (!row) return;
    // Only scroll the link row if the active link is actually hidden,
    // so "All docs" stays visible whenever it can.
    const active = $('a.active', row);
    if (active) {
      const right = active.offsetLeft + active.offsetWidth - row.offsetLeft;
      if (right > row.clientWidth) row.scrollLeft = right - row.clientWidth + 24;
    }
    // Fade whichever edge has more links beyond it.
    const edges = () => {
      row.classList.toggle('more-left', row.scrollLeft > 2);
      row.classList.toggle('more-right', row.scrollLeft + row.clientWidth < row.scrollWidth - 2);
    };
    row.addEventListener('scroll', edges, { passive: true });
    window.addEventListener('resize', edges);
    edges();
  };

  const renderToc = () => {
    const toc = $('#page-toc');
    const main = $('.main-col');
    if (!toc || !main) return;
    const groups = $$('.section', main).map((sec) => {
      const h2 = $(':scope > h2', sec);
      const items = $$(':scope > h3', sec)
        .map((h3) => `<li><a href="#${h3.id}" data-target="${h3.id}">${escapeHtml(h3.textContent)}</a></li>`)
        .join('');
      if (!h2) return items;
      return `<li><a class="toc-h2" href="#${sec.id}" data-target="${sec.id}">${escapeHtml(h2.textContent)}</a>${items ? `<ul>${items}</ul>` : ''}</li>`;
    }).join('');
    toc.innerHTML = `<h2>On this page</h2><ul>${groups}</ul>`;
  };

  // Highlight the heading currently at the top of the viewport.
  const scrollSpy = () => {
    const toc = $('#page-toc');
    if (!toc) return;
    const links = $$('a[data-target]', toc);
    const targets = links.map((a) => document.getElementById(a.dataset.target)).filter(Boolean);
    if (!targets.length) return;
    let lastActive = null;
    let ticking = false;
    const update = () => {
      ticking = false;
      let activeId = targets[0].id;
      for (const t of targets) {
        const anchor = t.classList.contains('section') ? ($(':scope > h2', t) || t) : t;
        if (anchor.getBoundingClientRect().top <= 110) activeId = t.id; else break;
      }
      if (activeId === lastActive) return;
      lastActive = activeId;
      let activeLink = null;
      links.forEach((a) => {
        const on = a.dataset.target === activeId;
        a.classList.toggle('active', on);
        if (on) activeLink = a;
      });
      // Keep it visible inside the sidebar's own scroll area without
      // scrolling the page itself.
      if (activeLink && toc.scrollHeight > toc.clientHeight) {
        const top = activeLink.offsetTop;
        if (top < toc.scrollTop + 40 || top > toc.scrollTop + toc.clientHeight - 40) {
          toc.scrollTop = top - toc.clientHeight / 2;
        }
      }
    };
    window.addEventListener('scroll', () => {
      if (!ticking) { ticking = true; requestAnimationFrame(update); }
    }, { passive: true });
    update();
  };

  const renderPager = () => {
    const pager = $('#pager');
    if (!pager) return;
    const i = PAGES.findIndex((p) => p.slug === current);
    if (i < 0) return;
    const prev = i === 0 ? { file: 'index.html', title: 'All docs' } : PAGES[i - 1];
    const next = PAGES[i + 1];
    pager.innerHTML =
      `<a class="prev" href="${prev.file}"><span class="p-label">← Previous</span><span class="p-title">${escapeHtml(prev.title)}</span></a>` +
      (next
        ? `<a class="next" href="${next.file}"><span class="p-label">Next →</span><span class="p-title">${escapeHtml(next.title)}</span></a>`
        : '<span></span>');
  };

  const renderTiles = () => {
    const tiles = $('#doc-tiles');
    if (!tiles) return;
    tiles.innerHTML = PAGES.map((p) => `
      <a class="doc-tile" href="${p.file}">
        <span class="t-icon" aria-hidden="true">${p.icon}</span>
        <span class="t-title">${escapeHtml(p.title)}</span>
        <span class="t-blurb">${escapeHtml(p.blurb)}</span>
      </a>`).join('');
  };

  // ── Search ─────────────────────────────────────────────────────────
  // Built lazily on first focus: this page is read from the live DOM,
  // every other page is fetched once and parsed. One entry per section
  // intro and per h3 block.
  let indexPromise = null;
  let indexNote = '';

  const entriesFrom = (doc, page) => {
    ensureIds(doc);
    const out = [];
    $$('.main-col .section', doc).forEach((sec) => {
      const h2 = $(':scope > h2', sec);
      let cur = h2 ? { page, heading: h2.textContent.trim(), id: sec.id, text: '', isSection: true } : null;
      if (cur) out.push(cur);
      Array.from(sec.children).forEach((child) => {
        if (child.tagName === 'H2') return;
        if (child.tagName === 'H3') {
          cur = { page, heading: child.textContent.trim(), id: child.id, text: '' };
          out.push(cur);
          return;
        }
        if (cur) cur.text += ` ${child.textContent.replace(/\s+/g, ' ').trim()}`;
      });
    });
    out.forEach((e) => { e.text = e.text.trim(); });
    return out;
  };

  const buildIndex = () => {
    if (indexPromise) return indexPromise;
    let failed = 0;
    const remote = PAGES.filter((p) => p.slug !== current).length;
    indexPromise = Promise.all(PAGES.map((p) => (p.slug === current
      ? Promise.resolve(entriesFrom(document, p))
      : fetch(p.file)
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
        .then((html) => entriesFrom(new DOMParser().parseFromString(html, 'text/html'), p))
        .catch(() => { failed += 1; return []; })
    ))).then((lists) => {
      if (failed === remote && remote > 0) {
        indexNote = 'Only this page could be searched — open the docs through the app to search every page.';
      } else if (failed) {
        indexNote = `${failed} page(s) could not be searched.`;
      }
      return lists.flat();
    });
    return indexPromise;
  };

  const findMatches = (entries, terms) => entries.map((e) => {
    const h = e.heading.toLowerCase();
    const t = e.text.toLowerCase();
    let score = 0;
    for (const term of terms) {
      const inHeading = h.includes(term);
      if (!inHeading && !t.includes(term)) return null;
      score += inHeading ? 10 : 1;
      if (h.startsWith(term)) score += 5;
    }
    if (e.isSection) score -= 2;
    // Release notes repeat the topic pages' feature text; rank the
    // topic page (how it works now) above the changelog entry.
    if (e.page.slug === 'release-notes') score -= 3;
    return { e, score };
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 12).map((r) => r.e);

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Split the RAW text on the terms, then escape each piece — so a term
  // can never match inside an entity or an inserted <mark> tag.
  const highlight = (text, terms) => {
    if (!terms.length) return escapeHtml(text);
    const re = new RegExp(`(${terms.map(escapeRe).join('|')})`, 'gi');
    return text.split(re).map((part, i) => (i % 2 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part))).join('');
  };

  const snippet = (text, terms) => {
    const lower = text.toLowerCase();
    let pos = -1;
    terms.forEach((t) => {
      const p = lower.indexOf(t);
      if (p >= 0 && (pos < 0 || p < pos)) pos = p;
    });
    if (pos < 0) return text.length > 140 ? `${text.slice(0, 140).trim()}…` : text;
    const start = Math.max(0, pos - 50);
    const end = Math.min(text.length, pos + 100);
    return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
  };

  const setupSearch = () => {
    const input = $('#docs-search-input');
    const box = $('#docs-search-results');
    if (!input || !box) return;
    let results = [];
    let active = -1;
    let seq = 0;

    const openBox = () => { box.classList.add('open'); input.setAttribute('aria-expanded', 'true'); };
    const closeBox = () => { box.classList.remove('open'); input.setAttribute('aria-expanded', 'false'); };
    const markActive = () => {
      $$('a', box).forEach((a, i) => a.classList.toggle('active', i === active));
      const el = $$('a', box)[active];
      if (el) el.scrollIntoView({ block: 'nearest' });
    };

    const paint = (q, terms) => {
      const note = indexNote ? `<div class="r-empty">${escapeHtml(indexNote)}</div>` : '';
      if (!results.length) {
        box.innerHTML = `<div class="r-empty">No matches for “${escapeHtml(q)}”.</div>${note}`;
      } else {
        box.innerHTML = results.map((e, i) => {
          const href = `${e.page.slug === current ? '' : e.page.file}#${e.id}`;
          return `<a href="${href}" role="option"${i === active ? ' class="active"' : ''}>
              <div class="r-page">${escapeHtml(e.page.title)}</div>
              <div class="r-title">${highlight(e.heading, terms)}</div>
              ${e.text ? `<div class="r-snippet">${highlight(snippet(e.text, terms), terms)}</div>` : ''}
            </a>`;
        }).join('') + note;
      }
      openBox();
    };

    const run = () => {
      const q = input.value.trim();
      if (!q) { closeBox(); box.innerHTML = ''; results = []; return; }
      const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
      const mine = ++seq;
      if (!box.classList.contains('open')) {
        box.innerHTML = '<div class="r-empty">Searching…</div>';
        openBox();
      }
      buildIndex().then((entries) => {
        if (mine !== seq) return;
        results = findMatches(entries, terms);
        active = results.length ? 0 : -1;
        paint(q, terms);
      });
    };

    input.addEventListener('focus', () => { buildIndex(); if (input.value.trim()) run(); });
    input.addEventListener('input', run);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        if (!results.length) return;
        ev.preventDefault();
        active = (active + (ev.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
        markActive();
      } else if (ev.key === 'Enter') {
        const el = $$('a', box)[active];
        if (el) { ev.preventDefault(); el.click(); }
      } else if (ev.key === 'Escape') {
        if (input.value) { input.value = ''; run(); } else { input.blur(); }
      }
    });
    box.addEventListener('click', (ev) => {
      if (ev.target.closest('a')) { closeBox(); input.blur(); }
    });
    document.addEventListener('click', (ev) => {
      if (!(ev.target instanceof Element) || !ev.target.closest('.docs-search')) closeBox();
    });
    document.addEventListener('keydown', (ev) => {
      const t = ev.target;
      const typing = t instanceof Element && t.closest('input, textarea, select, [contenteditable="true"]');
      const slash = ev.key === '/' && !typing;
      const cmdK = (ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k';
      if (slash || cmdK) {
        ev.preventDefault();
        input.focus();
        input.select();
      }
    });
  };

  ensureIds(document);
  renderNav();
  renderToc();
  renderPager();
  renderTiles();
  setupSearch();
  scrollSpy();
  // The nav is injected after the browser's first anchor jump; re-apply
  // it so a deep link (page.html#heading) lands below the sticky bar.
  if (location.hash) {
    requestAnimationFrame(() => {
      const el = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (el) el.scrollIntoView();
    });
  }
})();
