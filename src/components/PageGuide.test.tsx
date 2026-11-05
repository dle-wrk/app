import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { PAGE_GUIDES } from './PageGuide';

// The pages the sidebar lists (src/components/Sidebar.tsx).
const sidebar = readFileSync(resolve(__dirname, 'Sidebar.tsx'), 'utf-8');
const SIDEBAR_PAGES = [...sidebar.matchAll(/\{ id: '([a-z_-]+)', label: '/g)].map((m) => m[1]);

describe('page guides', () => {
  it('every page in the sidebar has one', () => {
    expect(SIDEBAR_PAGES.length).toBeGreaterThan(20);
    expect(SIDEBAR_PAGES.filter((p) => !(p in PAGE_GUIDES))).toEqual([]);
  });

  it('each "Read the full guide" link goes to a section that exists in the docs', () => {
    for (const [view, g] of Object.entries(PAGE_GUIDES)) {
      if (!g?.doc) continue;
      const [file, anchor] = g.doc.split('#');
      const html = readFileSync(resolve(__dirname, '../../public/docs', file), 'utf-8');
      expect(html.includes(`id="${anchor}"`), `${view}: ${g.doc}`).toBe(true);
    }
  });

  it('each has a title and at least one step', () => {
    for (const g of Object.values(PAGE_GUIDES)) {
      expect(g!.title.length).toBeGreaterThan(3);
      expect(g!.steps.length).toBeGreaterThan(0);
    }
  });
});
