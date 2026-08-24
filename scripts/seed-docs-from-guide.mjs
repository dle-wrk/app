// One-shot seeder: converts each section of public/tracklab-complete-guide.html
// into a doc and emits INSERT statements you paste into the Neon SQL editor.
//
// Usage:  node scripts/seed-docs-from-guide.mjs > seed-docs.sql
//         then open seed-docs.sql, copy contents, paste into Neon → Run.
//
// Re-runs are safe: each INSERT is `ON CONFLICT (slug) DO UPDATE`, so tweaking
// the guide and re-seeding overwrites the same rows in place.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '..', 'public', 'tracklab-complete-guide.html'), 'utf8');
const dom = new JSDOM(html);
const { document } = dom.window;

const td = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});
// Strip decorative wrapper divs so we don't end up with empty-line-heavy output.
td.remove(['style', 'script']);
td.addRule('unwrapTip', {
  filter: (node) => node.nodeName === 'DIV' && /^(tip|success|warning|step)$/.test(node.className || ''),
  replacement: (content) => `\n> ${content.trim().replace(/\n/g, '\n> ')}\n`,
});

// Section id → { title, category, sortOrder }.
// Category groups them in the sidebar; sortOrder controls in-category order.
const META = {
  'whats-new':      { title: "What's new (v2.6)",       category: 'Overview',      sortOrder: 5 },
  'getting-started':{ title: 'Getting started',         category: 'Overview',      sortOrder: 10 },
  'dashboard':      { title: 'Dashboard overview',      category: 'Overview',      sortOrder: 20 },
  'inventory':      { title: 'Inventory management',    category: 'Operations',    sortOrder: 10 },
  'suppliers':      { title: 'Supplier management',     category: 'Operations',    sortOrder: 20 },
  'pricing':        { title: 'Pricing directory',       category: 'Operations',    sortOrder: 30 },
  'manufacturing':  { title: 'Manufacturing & production', category: 'Operations', sortOrder: 40 },
  'bookkeeping':    { title: 'Bookkeeping & accounting', category: 'Bookkeeping',  sortOrder: 10 },
  'automation':     { title: 'Automation & workflow',   category: 'Automation',    sortOrder: 10 },
  'quality':        { title: 'Quality & compliance',    category: 'Automation',    sortOrder: 20 },
  'advanced':       { title: 'Advanced features',       category: 'Automation',    sortOrder: 30 },
  'tips':           { title: 'Pro tips & best practices', category: 'Overview',    sortOrder: 100 },
};

const escapeSql = (s) => s.replace(/'/g, "''");

console.log('-- Seed / refresh in-app documentation from the static user guide.');
console.log('-- Safe to re-run: ON CONFLICT (slug) DO UPDATE overwrites in place.');
console.log('');

for (const [id, meta] of Object.entries(META)) {
  const section = document.getElementById(id);
  if (!section) {
    console.error(`# skipping ${id}: not found in HTML`);
    continue;
  }
  // Drop the outer h2 (we already have a title in META) so the heading level
  // in the markdown starts at h3-→ h1 for a cleaner rendered doc.
  const h2 = section.querySelector('h2');
  if (h2) h2.remove();

  let md = td.turndown(section.innerHTML);
  // Cleanups: collapse triple+ blank lines, strip stray non-breaking spaces,
  // trim.
  md = md.replace(/\n{3,}/g, '\n\n').replace(/ /g, ' ').trim();

  const slug = id.replace(/^-+|-+$/g, '');
  console.log(`-- ${meta.title} (category: ${meta.category})`);
  console.log(`INSERT INTO app_docs (slug, title, category, content, sort_order, updated_by, updated_at)`);
  console.log(`VALUES ('${escapeSql(slug)}', '${escapeSql(meta.title)}', '${escapeSql(meta.category)}',`);
  console.log(`        '${escapeSql(md)}',`);
  console.log(`        ${meta.sortOrder}, 'seed-script', CURRENT_TIMESTAMP)`);
  console.log(`ON CONFLICT (slug) DO UPDATE`);
  console.log(`   SET title      = EXCLUDED.title,`);
  console.log(`       category   = EXCLUDED.category,`);
  console.log(`       content    = EXCLUDED.content,`);
  console.log(`       sort_order = EXCLUDED.sort_order,`);
  console.log(`       updated_at = CURRENT_TIMESTAMP,`);
  console.log(`       updated_by = 'seed-script';`);
  console.log('');
}

console.log('-- Done.');
