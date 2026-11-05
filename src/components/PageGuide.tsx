// The "?" next to each page's name in the top bar: a short how-to for the
// page, and a link to its part of the user documentation (public/docs).

import React from 'react';
import HowToTip from './HowToTip';
import type { ViewType } from '../types';

interface Guide { title: string; steps: React.ReactNode[]; note?: React.ReactNode; doc?: string }

export const PAGE_GUIDES: Partial<Record<ViewType, Guide>> = {
  dashboard: {
    title: 'The dashboard',
    steps: [
      <>The cards at the top: active projects, low stock alerts and critical shortages, with stock by type below.</>,
      <><strong>Needs attention today</strong> lists what is overdue or short across sales, purchases and stock.</>,
      <>Press <strong>Ctrl+K</strong> (⌘K on a Mac) anywhere to jump to a page, an item or a document number.</>,
    ],
    doc: 'getting-started.html#key-metrics-cards',
  },
  items: {
    title: 'Items & Inventory',
    steps: [
      <>Search by stock code, name, value or part number; filter by category, status or <em>Sourcing</em> (which suppliers an item has a part number for).</>,
      <>Click an item to open it: details, stock, part numbers, suppliers and where it's kept. Edit from there.</>,
      <><strong>Book In Component</strong> (top bar) adds received stock; <strong>Add Item</strong> makes a new stock code.</>,
      <><strong>Sync Stock</strong> reloads everything and puts part numbers in the right supplier slots (1 Mouser, 2 DigiKey, 3 LCSC, 4–5 other).</>,
    ],
    doc: 'inventory.html#accessing-inventory',
  },
  production_costs: {
    title: 'Production Costs',
    steps: [
      <>Each product you make: its model number, production cost, selling price and margin.</>,
      <>Edit a row, or <strong>Export CSV</strong>, change it in Excel and <strong>Import</strong>: you see what's new and what changes before anything is saved.</>,
      <>Project Processing books built units in under these model numbers.</>,
    ],
    doc: 'manufacturing.html#production-costs',
  },
  stock_places: {
    title: 'Locations & Counts',
    steps: [
      <><strong>Locations</strong>: the bins and shelves stock is kept in. <em>One bin per item</em> makes a bin for every item at once.</>,
      <><strong>Scan</strong>: scan a bin label, then items, to put them away; print bin and item labels.</>,
      <><strong>Check stock</strong>: count a bin, some items or everything. Change only what differs, then Confirm.</>,
      <><strong>Lot tracing</strong>: where a lot is and which builds used it.</>,
    ],
    doc: 'inventory.html#locations-and-counts',
  },
  stock_kits: {
    title: 'Stock Tables',
    steps: [
      <>Stock health at a glance: the value of stock at cost and at bulk price, and what's set aside (inactive and do-not-use).</>,
      <>The tabs: item pricing, production kits, projects, stock movements and the users ledger. Each can be exported as CSV.</>,
    ],
    doc: 'inventory.html#stock-tables-and-kits',
  },
  reports_ledger: {
    title: 'Reports & Ledger',
    steps: [
      <>Every stock movement: book-ins, book-outs, counts, returns and builds, with who did it and why.</>,
      <>Pick an item to see its movements over time and its net change.</>,
    ],
    doc: 'inventory.html#reports-and-ledger',
  },
  pricing: {
    title: 'Pricing Directory',
    steps: [
      <><strong>Live Price Lookup</strong>: one part's price and stock at Mouser, DigiKey, LCSC and the other suppliers set up.</>,
      <><strong>Bulk Pricing</strong>: price many items at once, review the problems, and keep the price history.</>,
      <><strong>Part numbers</strong>: put supplier numbers in the right slots, and review and fix the ones that look wrong.</>,
      <><strong>Price Directory</strong>: every item's prices; <strong>API keys</strong>: the suppliers' credentials (admins).</>,
    ],
    doc: 'suppliers-pricing.html#accessing-pricing-tools',
  },
  suppliers: {
    title: 'Suppliers',
    steps: [
      <>Your suppliers with their contact details and lead times; a lead time is measured from received purchase orders once there are some.</>,
      <>Add or edit a supplier here. Its purchase orders and bills are under Bookkeeping.</>,
    ],
    doc: 'suppliers-pricing.html#accessing-suppliers',
  },
  bookkeeping: {
    title: 'Bookkeeping',
    steps: [
      <><strong>Sales</strong>: customers, quotes and sales orders, invoices, recurring invoices, returns, credit notes and payments received.</>,
      <><strong>Purchases</strong>: purchase orders, bills, expenses, landed cost and payments made.</>,
      <><strong>Accounting</strong> and <strong>Reports</strong>: the ledger, bank reconciliation, VAT201 and the financial reports, each saved as PDF.</>,
      <>Every document can be saved as a PDF; a draft can be edited until it is sent or posted.</>,
    ],
    doc: 'accounting.html#accessing-the-bookkeeping-module',
  },
  kit_booking: {
    title: 'P&P Kit Booking',
    steps: [
      <>Choose a project and how many to build: the BOM is checked against stock, with shortages shown.</>,
      <>Pick the reels for a line (<em>Pick SKUs</em>), mark a line DNF, or export the shortages.</>,
      <><strong>Lock</strong> a kit to reserve its stock for other kits' checks; <strong>Confirm Kit Booking</strong> takes it out of stock.</>,
      <>To follow a build through to booking in the units and counting back, use Projects → Project Processing.</>,
    ],
    doc: 'manufacturing.html#production-kits',
  },
  bom_manager: {
    title: 'Bill of Materials',
    steps: [
      <>Choose a project: its BOM lines (stock code, quantity, designators), matched against stock, with the shortages and what is allocated.</>,
      <>Click a part to open it, and download the supplier order files for a build.</>,
    ],
    doc: 'manufacturing.html#bill-of-materials-bom',
  },
  material_planning: {
    title: 'Material Planning',
    steps: [
      <>Everything open sales orders and planned builds need, against stock and open purchase orders, by date.</>,
      <>Each part shows when it first runs short, how many to buy and the date to order by.</>,
      <>Tick parts and draft purchase orders, one per supplier.</>,
    ],
    doc: 'manufacturing.html#material-planning',
  },
  pick_place: {
    title: 'Pick & Place',
    steps: [
      <>A board's placement directory: each stock code with its designators, and the feeders it needs (tape reels and IC trays).</>,
      <>Click a part to view or edit it.</>,
    ],
    doc: 'manufacturing.html#pick-and-place-operations',
  },
  alternates: {
    title: 'Component Alternates',
    steps: [
      <>The parts that can stand in for one another (same value, footprint and, for LEDs, colour), with their stock: ok, low or out.</>,
      <>A group's <em>Simulation map</em> shows its alternates around the one with the most stock, sized by stock and coloured by health; click one to open it.</>,
    ],
    doc: 'manufacturing.html#component-alternates',
  },
  supplier_bom: {
    title: 'Supplier BOM Generator',
    steps: [
      <>Load a BOM CSV (a part-number and a qty column; DNF lines are skipped) and set the board quantity.</>,
      <>A tab per supplier (LCSC, DigiKey, Mouser, RS) shows each part's number there; red rows have none.</>,
      <>On the RS tab, <em>Find on RS</em> searches RS for a part; paste the stock number and Save it to the item.</>,
      <>Export each supplier's file in the shape its upload takes.</>,
    ],
    doc: 'manufacturing.html#supplier-bom-generator',
  },
  projects: {
    title: 'Project Manager',
    steps: [
      <>Your projects: create one, edit it, set its team, dates and status.</>,
      <>Each card shows the stage it's at; click the stage to open the Project Progress board.</>,
      <>The procurement shortage checker shows what a project is short of.</>,
    ],
    doc: 'manufacturing.html#project-management',
  },
  project_progress: {
    title: 'Project Progress',
    steps: [
      <>Every project in the stage it has reached. Move one with its arrows, by dragging, or with <em>Move to</em>.</>,
      <>Open a project to put it on hold, add an update or see its history.</>,
      <>Click a count at the top to show only those projects.</>,
    ],
    doc: 'manufacturing.html#project-progress',
  },
  project_processing: {
    title: 'How to run a build',
    steps: [
      <><strong>New build:</strong> choose the project, what it builds (its Production Costs code) and how many. It gets a build number and a batch code.</>,
      <><strong>Book the kit out:</strong> open the build, press <em>Check the kit</em>, then <em>Book out</em>. A short line stops it: tick <em>Leave out</em>, or book that stock in first.</>,
      <><strong>Label and book in:</strong> print the unit labels (and the batch label), stick one on each unit, and scan it when it's done. Or type how many and press <em>Book in</em>. <em>Change the formats</em> sets the serials, e.g. TCU06-POP-{'{0000}'}.</>,
      <><strong>Count what's left:</strong> type what came back of each part. It goes back to that part, or tick <em>Packet</em> for loose parts off a reel (they go to a packet item, e.g. CAP-024-PKT).</>,
      <><strong>Complete:</strong> say how many were scrapped, add a note, press <em>Complete</em>.</>,
    ],
    note: <>Every step is in the stock ledger under the build number. A build can be cancelled until its kit is booked out.</>,
    doc: 'manufacturing.html#project-processing',
  },
  automation: {
    title: 'Automation',
    steps: [
      <><strong>Automation Rules</strong>: when something is true (low stock, an overdue invoice or NCR, …), tell people or draft purchase orders, every hour, day or week. Start from a ready-made rule; <em>What it finds</em> looks first.</>,
      <><strong>Scheduled Jobs</strong>: the app's own background work, with its last result; turn one off or run it now.</>,
      <><strong>Notifications</strong>: what rules have told you. <strong>Event Log</strong>: everything that ran.</>,
    ],
    doc: 'automation-quality.html#accessing-automation',
  },
  auto_po_config: {
    title: 'Auto-PO Config',
    steps: [
      <><strong>Watch items</strong>: pick items and set a reorder point and the level to order back up to, and the supplier.</>,
      <><strong>Check now</strong> shows the purchase orders it would draft (one per supplier) and what it skips; <strong>Draft</strong> makes them.</>,
      <>Nothing is ordered on its own: the drafts are priced at last cost; check them before sending.</>,
    ],
    doc: 'automation-quality.html#auto-po-configuration',
  },
  quality_compliance: {
    title: 'Quality & Compliance',
    steps: [
      <><strong>Inspections</strong>: schedule one, then record the result. A failed one offers to log the defect or raise an NCR.</>,
      <><strong>Defects</strong> and <strong>NCRs</strong>: report, assign, work through and close, saying how it was fixed.</>,
      <><strong>Compliance</strong>: a checkpoint for each check your standard asks for; record each time it's checked.</>,
      <>The overview's <em>Needs attention</em> lists what is overdue or failing.</>,
    ],
    doc: 'automation-quality.html#accessing-quality-module',
  },
  advanced_automation: {
    title: 'Advanced Automation',
    steps: [
      <><strong>Scan for Anomalies</strong>, <strong>Generate Forecasts</strong>, <strong>Score Suppliers</strong>: worked out from stock, the ledger, orders and NCRs. They also run daily.</>,
      <>On <em>Anomalies</em>, mark each one acknowledged, being investigated, resolved or not a problem.</>,
      <><em>Reorder</em> suggests what to order, with the supplier files. Where there isn't enough history, it says so rather than guess.</>,
    ],
    doc: 'automation-quality.html#advanced-automation-dashboard',
  },
  settings: {
    title: 'Settings',
    steps: [
      <><strong>System</strong>: language, alerts, the display theme and the data connection. <strong>Users</strong>: add people and set their role (admins).</>,
    ],
    doc: 'getting-started.html#essential-settings',
  },
  'activity-logs': {
    title: 'Activity Logs',
    steps: [<>Who did what and when. Filter by action, result, user and date range (<em>Quick range</em>).</>],
  },
  documentation: {
    title: 'Documentation',
    steps: [<>The user guide, a page per part of the app. Search it, or use the contents on the right of each page.</>],
  },
};

/** The "?" for a page, if it has a guide. */
export default function PageGuide({ view }: { view: ViewType }) {
  const g = PAGE_GUIDES[view];
  if (!g) return null;
  return (
    <HowToTip title={g.title}>
      <ol className="list-decimal pl-4 space-y-1">{g.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
      {g.note && <p className="mt-2 text-outline">{g.note}</p>}
      {g.doc && <a href={`/docs/${g.doc}`} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-primary font-bold hover:underline">Read the full guide →</a>}
    </HowToTip>
  );
}
