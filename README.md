# Tracklab IM

![React](https://img.shields.io/badge/React-19.0.1-61DAFB?logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8.2-3178C6?logo=typescript)
![Vite](https://img.shields.io/badge/Vite-6.2.3-646CFF?logo=vite)
![Express](https://img.shields.io/badge/Express-4.21.2-000000?logo=express)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Neon-336791?logo=postgresql)
![Tailwind](https://img.shields.io/badge/Tailwind_CSS-4.1.14-38B2AC?logo=tailwind-css)
![License](https://img.shields.io/badge/License-Apache--2.0-green)

**Tracklab IM** is a Data Captuiring and inventory management platform purpose-built for electronics manufacturing environments. It pairs a high-performance **React 19** single-page front end with a real **Express + PostgreSQL** (Neon) REST API to deliver live inventory tracking, bill of materials (BOM) management, pick-and-place coordination, supplier benchmarking, kit booking with stock audits, and AI-driven restock recommendations.

> **View in AI Studio:** [Launch Application](https://ai.studio/apps/44e2600c-39fe-4013-882a-9501e1df50b3)

---

## Table of Contents

- [Table of Contents](#table-of-contents)
- [Features](#features)
- [Architecture Overview](#architecture-overview)
  - [Design Principles](#design-principles)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Data Model](#data-model)
  - [Item](#item)
  - [Transaction](#transaction)
  - [Supplier & Project](#supplier-project)
  - [BOM / Pick & Place](#bom--pick--place)
  - [Production Kit & Settings](#production-kit--settings)
- [Feature Modules](#feature-modules)
  - [Dashboard](#dashboard)
  - [Items & Inventory](#items-inventory)
  - [Stock Tables](#stock-tables)
  - [Reports & Ledger](#reports-ledger)
  - [Pricing Directory](#pricing-directory)
  - [Suppliers](#suppliers)
  - [BOM Manager](#bom-manager)
  - [Pick & Place](#pick--place)
  - [Component Alternates](#component-alternates)
  - [Projects](#projects)
  - [Kit Booking](#kit-booking)
  - [Settings](#settings)
  - [Search](#search)
  - [Profile](#profile)
- [API Reference](#api-reference)
  - [Items](#items)
  - [Suppliers (API)](#suppliers-api)
  - [Projects & BOM](#projects--bom)
  - [Transactions & Kits](#transactions--kits)
  - [Settings & Misc](#settings--misc)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Development](#development)
  - [Production Build](#production-build)
- [Environment Configuration](#environment-configuration)
- [Available Scripts](#available-scripts)
- [Development Patterns](#development-patterns)
  - [State Management](#state-management)
  - [Custom Event Communication](#custom-event-communication)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
  - [Database Seeding](#database-seeding)
- [Key Algorithms](#key-algorithms)
  - [Stock Health Classification](#stock-health-classification)
  - [Type Prefix Extraction](#type-prefix-extraction)
  - [Imperial/Metric Conversion](#imperialmetric-conversion)
  - [Kit Booking Audit](#kit-booking-audit)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

---

## Features

- **Live inventory CRUD** backed by PostgreSQL with CSV import/export and automatic category inference from SKU prefixes.
- **BOM & Pick-and-Place management** per project, with XY placement data for SMT assembly programming.
- **Kit booking with transactional stock audits** — books out components across a build, automatically resolving approved alternates and blocking on shortages inside a database transaction.
- **Supplier benchmarking** — lead time, response time, and reliability scoring.
- **AI restock recommendations** via Google GenAI (server-side `MAJOR_CAPABILITY_SERVER_SIDE_GEMINI_API`).
- **Multi-timezone, themed UI** with configurable sync and alert thresholds, persisted to the database.

---

## Architecture Overview

Tracklab IM is a **full-stack** application. The React SPA communicates with an Express REST API over HTTP; the API layer persists to a Neon PostgreSQL database. In development, a custom Vite plugin transparently spawns the Express server (port `3001`) and proxies `/api/*` traffic from the Vite dev server (port `3000`), so a single `npm run dev` runs the whole stack.

```text
┌──────────────────────────────────────────────────────────────────────┐
│                         Browser (React 19 SPA)                       │
│  App.tsx (state container) ── hooks/useMemo/useEffect ── View Router  │
│  dashboard | items | stock | ledger | pricing | suppliers | bom | …   │
└───────────────┬──────────────────────────────────────────────────────┘
                │  fetch('/api/...')                (Vite proxy /api → :3001)
┌───────────────▼──────────────────────────────────────────────────────┐
│                       Express API (server.ts)                        │
│  Zod-validated routes · pg Pool · ensureSchema() bootstrap            │
└───────────────┬──────────────────────────────────────────────────────┘
                │  sql
┌───────────────▼──────────────────────────────────────────────────────┐
│                   PostgreSQL (Neon Serverless)                        │
│  inventory · suppliers · projects · transactions · production_kits    │
│  db_bom_project_<id> · pp_bom_project_<id> · settings · job_cards    │
└──────────────────────────────────────────────────────────────────────┘
```

### Design Principles

1. **Single source of truth (DB)** — All persistence lives in PostgreSQL. The client holds only a cached, derived view of the data and re-syncs from `/api/*` after mutations.
2. **Client-side derivation** — Filtering, sorting, KPI aggregation, and charts are computed via `useMemo` over the loaded record set, keeping rendering cheap.
3. **Validated boundaries** — Every API payload is validated with Zod (`ItemSchema`, supplier/project bodies) before touching the database.
4. **Transactional integrity** — Kit booking runs an `auditKitStock` check inside a `BEGIN … COMMIT/ROLLBACK` block so a partial shortfall never deducts stock.
5. **Seeded from CSV** — On first boot the schema is created and populated from `assets/*.csv`, so the app is instantly demoable against a fresh database.

---

## Tech Stack

| Layer | Technology | Version | Purpose |
| --- | --- | --- | --- |
| Runtime | React | 19.0.1 | UI framework with concurrent rendering |
| Language | TypeScript | ~5.8.2 | Static typing for all data contracts |
| Build Tool | Vite | 6.2.3 | Fast HMR dev server + optimized production build |
| Styling | Tailwind CSS | 4.1.14 | Utility-first CSS with CSS custom properties for theming |
| Fonts | Geist | 1.3.0 | Typeface for UI text |
| Icons | Lucide React | 0.546.0 | Consistent iconography |
| Animation | Motion | 12.23.24 | Gesture-driven and layout animations |
| API Server | Express | 4.21.2 | REST API and static/proxy host |
| Validation | Zod | 3.24.2 | Runtime request/response schema validation |
| Database Driver | `pg` | 8.22.0 | Node.js PostgreSQL client (pooled) |
| Serverless DB | `@neondatabase/serverless` | 1.1.0 | Neon PostgreSQL connection (also usable via `pg`) |
| Config | `dotenv` | 17.2.3 | Loads environment variables |
| Compression | `compression` | 1.7.5 | Gzip for API responses |
| Runtime (TS) | `tsx` | 4.21.0 | Runs `server.ts` directly in dev |
| AI Integration | `@google/genai` | 2.4.0 | Server-side restock recommendations & search |

---

## Project Structure

```text
tracklab-im-v2/
├── assets/                         # Seed CSVs (inventory, suppliers, BOMs, pick-place)
│   ├── MainInventory.csv
│   ├── Suppliers.csv
│   ├── Projects.csv
│   ├── component_alternates.csv
│   ├── dbBOM_*_PCB.csv
│   └── PP_BOM_*_PCB.csv
├── public/
│   └── (served statically)
├── src/
│   ├── components/
│   │   ├── views/
│   │   │   ├── DashboardView.tsx      # KPI bento grid, category chart, live feed
│   │   │   ├── InventoryView.tsx      # Items CRUD, filtering, CSV import/export
│   │   │   ├── StockTablesView.tsx    # Production kits, users ledger, pricing
│   │   │   ├── LedgerView.tsx         # Transactions + AI recommendations
│   │   │   ├── PricingView.tsx        # Bulk pricing & supplier benchmarks
│   │   │   ├── SuppliersView.tsx      # Supplier directory & reliability
│   │   │   ├── SettingsView.tsx       # Theme, timezone, thresholds
│   │   │   ├── ProfileView.tsx        # Operator identity & clearance
│   │   │   ├── SearchView.tsx         # Global AI/search
│   │   │   ├── KitBookingView.tsx     # Validate + execute kit builds
│   │   │   └── ProjectsView.tsx       # Project portfolio management
│   │   ├── BOMManager.tsx             # BOM lines per project
│   │   ├── PickPlaceManager.tsx       # SMT placement coordinate management
│   │   ├── AlternatesManager.tsx      # Alternate part cross-referencing
│   │   ├── BulkPricingWizard.tsx      # 1000-unit pricing simulation
│   │   ├── ItemDetailModal.tsx        # Item editor + unit conversion
│   │   ├── ProductionKitsManager.tsx  # Kit assembly tracking
│   │   └── Sidebar.tsx                # Navigation & system status
│   ├── lib/
│   │   └── db.ts                      # pg Pool, query helpers, CSV seeding
│   ├── App.tsx                        # State container, data loader, view router
│   ├── main.tsx                       # React entry point
│   ├── types.ts                       # TypeScript interfaces & unions
│   ├── mockData.ts                    # Fallback seeds, CSV (de)serialization
│   └── index.css                      # Tailwind + theme tokens
├── server.ts                         # Express REST API + schema bootstrap
├── vite.config.ts                    # Vite + React + Tailwind + backend-spawn plugin
├── tailwind.config.js
├── tsconfig.json
├── .env.example
├── metadata.json                     # AI Studio application metadata
└── README.md
```

---

## Data Model

Records are stored in **snake_case** PostgreSQL tables and mapped to **camelCase** TypeScript models (`serial_number` → `partNumber`, `qty_per_unit` → `quantity`, etc.) at the API boundary. The canonical client model is defined in `src/types.ts`.

### Item

The central inventory record (table `inventory`).

```typescript
interface Item {
  partNumber: string;        // SKU, maps to DB serial_number (e.g. "CAP-001")
  name: string;
  description: string;
  manufacturer: string;
  stockLevel: number;        // maps to DB stock
  status: 'ACTIVE' | 'INACTIVE' | 'BOOKED OUT' | 'DISCONTINUED';
  lowStockLvl?: number;
  price: number;
  bulkPriceUsd?: number;
  bulkPriceZar?: number;
  supplier?: string;
  value?: string;            // "100nF", "4.7kΩ"
  size?: string;             // imperial, e.g. "0603"
  sizeMetric?: string;       // metric, e.g. "1608"
  packageName?: string;
  tolerance?: string;
  footprint?: string;
  datasheet?: string;
  category: string;
  itemType?: string;
  project?: string;
  packaging?: string;
  manPns?: string[];         // up to 5 manufacturer part numbers
  supPns?: string[];         // up to 5 supplier part numbers
  weblinks?: string[];       // up to 5 external links
  lastOrderQty?: number;
  lastOrderDate?: string;
}
```

### Transaction

Immutable audit entry for every stock movement (table `transactions`).

```typescript
interface Transaction {
  id: string;
  itemPartNumber: string;
  itemName: string;
  type: 'INBOUND' | 'OUTBOUND' | 'TRANSFER' | 'BOOK-IN' | 'BOOK-OUT';
  qtyChange: number;
  reference: string;
  performedBy: string;
  performedByAvatar?: string;
  dateTime: string;
  newCost?: number;
}
```

### Supplier & Project

```typescript
interface Supplier {
  id: string;
  name: string;
  website?: string;
  contactEmail?: string;
  notes?: string;
  leadTime?: number;
  responseTime?: number;
}

interface Project {
  id: number;
  projectName: string;
  description: string;
  status: string;
  createdDate: string;
}
```

### BOM / Pick & Place

Project-scoped manufacturing data. BOM rows live in `db_bom_project_<id>`; pick-and-place rows in `pp_bom_project_<id>`.

```typescript
interface BOMItem {
  id: string;
  projectId: number;
  stockCode: string;       // maps to Item.partNumber
  comment: string;
  description: string;
  designator: string;      // R1, C5, U3
  footprint: string;
  libref: string;
  quantity: number;        // qty per single board
}

interface PickPlaceItem {
  id: string;
  projectId: number;
  stockCode: string;
  comment: string;
  description: string;
  designator: string;
  footprint: string;
  libref: string;
  quantity: number;
}
```

### Production Kit & Settings

```typescript
interface ProductionKit {
  kitId: string;
  skuReference: string;
  status: 'READY' | 'STAGING' | 'BLOCKED' | 'ACTIVE';
  qtyAvailable: number;
  assemblyLine: string;
  lastUpdated: string;
  projectId?: number;
}

// Settings are stored as key/value JSON rows in the `settings` table.
interface SystemConfig {
  theme: 'dark' | 'light';
  timezone: string;
  syncFrequency: 'LIVE' | 'INTERVAL';
  lowStockThreshold: number;
  latencyWarningMs: number;
}
```

---

## Feature Modules

### Dashboard

The command center providing at-a-glance operational intelligence.

- **Bento-grid KPI cards** — total items, active projects, low-stock alerts, critical shortages, and asset valuation with trend indicators.
- **Category distribution chart** — dynamically scaled SVG bar chart of SKU counts per category, computed via `useMemo`.
- **Live transaction feed** — inbound, outbound, and book-in/out operations with operator attribution.
- **System health indicators** — API connection status, latency warnings, and sync animation feedback.

### Items & Inventory

Full CRUD lifecycle for inventory records, backed by `/api/items`.

- **Tri-mode filtering** — by type prefix (`CAP`, `RES`), operational status, and stock health tier (OK / LOW / CRITICAL).
- **Multi-column sorting** — by name, stock level, or unit price.
- **CSV Import/Export** — semicolon-delimited import with header auto-detection, category inference from SKU prefixes, and upsert (dedupe on `partNumber`). Export regenerates the canonical CSV via `generateCSVFromItems`.
- **Detail modals** — edit all properties with imperial/metric unit conversion.

#### CSV Import Format

Bulk import posts to `/api/items/bulk` (Zod-validated). Rows are semicolon-delimited; the first row is the header and subsequent rows are mapped by column index.

```csv
serial_number;name;description;value;size;package;tolerance;type;footprint;comment;datasheet;project;packaging;stock;qty_per_pcb;low_stock_lvl;current_cost_dollar;...
ANT-001;Fiberglass;Fiberglass Antenna LoRa 433MHz;antenna;;;;Product;;;;;;7;;;;;;;;;;;;;;;;;;;;;;;
```

### Stock Tables

Tabular views for operational data domains.

- **Production Kits** — kit-level inventory with SKU reference, assembly line, and status (READY / STAGING / BLOCKED / ACTIVE).
- **Users Ledger** — operator activity summary with transaction counts.
- **Item Pricing** — comprehensive pricing table with bulk tiers and supplier comparison.

### Reports & Ledger

Financial and operational reporting (`/api/transactions`).

- **Transaction history** — filterable by type, date range, and operator with CSV export.
- **AI-driven recommendations** — Google GenAI analyzes stock levels, lead times, and consumption to generate restock advisories.
- **Valuation summaries** — real-time inventory value (USD and ZAR) from stock levels and unit costs.

### Pricing Directory

Procurement intelligence module.

- **Bulk pricing wizard** — 1000-unit pricing simulation with category-specific bulk rates and supplier benchmarking.
- **Price trend indicators** — cost movement across suppliers.
- **Supplier reliability scores** — composite metrics from lead time, pricing consistency, and compliance.

### Suppliers (API)

Procurement partner management (`/api/suppliers`).

- **Supplier directory** — contact info, compliance status, and active pricing count.
- **Location-based filtering** and **reliability benchmarks** comparing lead/response times.

### BOM Manager

Bill of Materials for PCB assemblies (`/api/projects/:id/bom`).

- **Project-scoped BOMs** tied to a project ID for multi-product portfolios.
- **Component designators** (R1, C5, U3) linked to stock codes for traceability.
- **Substitution management** — approved alternates with automatic stock-impact calculation.
- **PCB quantity scaling** — total requirements computed dynamically from board quantity.

### Pick & Place

PCB assembly coordinate management (`/api/projects/:id/pp`).

- **XY coordinate tracking** for SMT placement machines.
- **Project isolation** — separate placement files per project with designator cross-referencing.
- **Export capabilities** — standard format for machine programming.

### Component Alternates

Cross-reference and alternate part selection.

- **Multi-supplier mapping** — up to 5 manufacturer and 5 supplier part numbers per component.
- **Compatibility scoring** — analysis of footprint, value, tolerance, and package.
- **Web link aggregation** — up to 5 external datasheet/product links.
- **Approved alternates** (`alternative_components`) used during kit-booking audits.

### Projects

Project portfolio management (`/api/projects`).

- Create, rename, and archive projects with descriptions and status.
- Each project owns its own BOM and pick-and-place tables (`db_bom_project_<id>`, `pp_bom_project_<id>`).

### Kit Booking

Transactional build execution (`/api/kit-booking/validate` & `/api/kit-booking/execute`).

- **Validate** — audits every BOM line against on-hand stock, resolving approved alternates and reporting per-component shortages without mutating data.
- **Execute** — books out the required quantities inside a single DB transaction, writes `BOOK-OUT` transactions, and creates a `job_card`. The whole operation rolls back if any component is short.

### Settings

Application-wide configuration persisted to the `settings` table (`/api/settings`).

- **Theme switching** — dark/light with CSS custom property transitions.
- **Timezone selection** — 12 pre-configured timezones with live clock updates.
- **Sync frequency** — LIVE or interval-based.
- **Alert thresholds** — configurable low-stock and latency warning parameters.

### Search

Global, AI-assisted search across inventory and related records.

### Profile

User identity and preferences.

- **Editable profile** — name, role, operator ID, bio with live preview.
- **Avatar support** — image URL with fallback initials.
- **Clearance levels** — numeric access tier for role-based visibility.

---

## API Reference

All routes are JSON. The Vite dev server proxies `/api/*` to Express on `:3001`; in production the same Express app serves the built SPA. Request bodies are validated with Zod.

### Items

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/items?limit=&offset=` | List items (paginated or full). |
| `POST` | `/api/items` | Upsert a single item (`serial_number` is the key). |
| `PUT`/`PATCH` | `/api/items/:serial_number` | Partial update of an item. |
| `POST` | `/api/items/bulk` | Bulk upsert an array of items. |

### Suppliers

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/suppliers` | List suppliers. |
| `POST` | `/api/suppliers` | Upsert supplier by `id`. |
| `PUT` | `/api/suppliers/:id` | Update supplier fields. |

### Projects & BOM

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/projects` | List projects. |
| `POST` | `/api/projects` | Create or update a project by name. |
| `PUT` | `/api/projects/:id` | Update a project. |
| `DELETE` | `/api/projects/:id` | Delete a project. |
| `GET` | `/api/projects/:id/bom` | BOM lines for a project. |
| `POST` | `/api/projects/:id/bom` | Upsert BOM lines. |
| `POST` | `/api/projects/:id/pp` | Upsert pick-and-place lines. |
| `GET` | `/api/bom-items` | Aggregate all BOM items across projects. |
| `GET` | `/api/pp-items` | Aggregate all pick-and-place items. |

### Transactions & Kits

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/transactions?limit=&offset=` | Recent transactions (newest first). |
| `POST` | `/api/transactions` | Append a transaction. |
| `GET` | `/api/production-kits` | List production kits. |
| `POST` | `/api/production-kits` | Upsert a production kit. |
| `GET` | `/api/job-cards` | List job cards. |
| `POST` | `/api/job-cards` | Create a job card. |
| `POST` | `/api/kit-booking/validate` | Audit stock for a build (no mutation). |
| `POST` | `/api/kit-booking/execute` | Book out components for a build (transactional). |

### Settings & Misc

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/settings` | All settings as a JSON object. |
| `POST` | `/api/settings` | Upsert settings (JSON body). |
| `GET` | `/api/tables` | List public table names. |
| `GET` | `/api/raw-table/:name` | Raw rows (max 1000) from a table. |
| `POST` | `/api/start` | Spawn the API server as a detached process. |

---

## Getting Started

### Prerequisites

- **Node.js** 18.0 or later
- **npm** 9.0 or later
- A **PostgreSQL** database (a free [Neon](https://neon.tech) serverless instance works out of the box)
- **Git** for version control

### Installation

```bash
# Clone the repository
git clone https://github.com/your-org/tracklab-im.git
cd tracklab-im-v2

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# then edit .env and set DATABASE_URL and GEMINI_API_KEY
# no separate DB API key is needed when using Neon
```

### Development

```bash
# Start the full stack (Vite dev server + Express API + DB bootstrap)
npm run dev
# → Front end:  http://localhost:3000
# → API (proxied): http://localhost:3001  (set via PORT)
```

`npm run dev` launches Vite, which auto-spawns `server.ts` via `tsx` and proxies `/api/*` traffic. On first run the API creates the schema and seeds it from `assets/*.csv`.

```bash
# Type-check the project (no emit)
npm run lint
```

### Production Build

```bash
# Create optimized production bundle
npm run build
# Output: dist/

# Preview the production build locally
npm run preview
```

For a production deployment, run `server.ts` (which serves `dist/` and the API) against a provisioned `DATABASE_URL`.

---

## Environment Configuration

Copy `.env.example` to `.env` and populate the values. AI Studio injects `GEMINI_API_KEY` and `APP_URL` automatically at runtime from user secrets.

```bash
# .env

# Required for AI-powered features (injected by AI Studio)
GEMINI_API_KEY=your_gemini_api_key_here

# Base URL where the app is hosted (injected by AI Studio)
APP_URL=http://localhost:3000

# Neon PostgreSQL connection string (required; no separate DB API key needed)
DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require

# Express backend port (proxied by Vite in dev)
PORT=3001
```

> `src/lib/db.ts` throws on startup if `DATABASE_URL` is missing, and `server.ts` refuses to boot the schema without it.

---

## Available Scripts

| Command | Action | Output |
| --- | --- | --- |
| `npm run dev` | Start Vite dev server + Express API | `http://localhost:3000` (proxy → `:3001`) |
| `npm run dev:vite` | Start Vite only (if API runs separately) | `http://localhost:3000` |
| `npm run build` | Production build | `dist/` directory |
| `npm run preview` | Preview production build | Serves `dist/` locally |
| `npm run lint` | TypeScript type check (`tsc --noEmit`) | Errors in terminal |
| `npm run clean` | Remove build artifacts | Deletes `dist/` and `server.js` |

---

## Development Patterns

### State Management

`App.tsx` owns the client-side state (items, suppliers, projects, transactions, kits, config). After any mutation it re-fetches the affected collection from the API and recomputes derived views with `useMemo`.

```typescript
// Load once, then keep in sync after mutations
useEffect(() => {
  Promise.all([
    fetch('/api/items'),
    fetch('/api/suppliers'),
    fetch('/api/projects'),
    fetch('/api/transactions'),
    fetch('/api/production-kits'),
    fetch('/api/bom-items'),
    fetch('/api/pp-items'),
    fetch('/api/settings'),
  ]).then(/* map & setItems / setSuppliers / … */);
}, []);

const filteredItems = React.useMemo(() => {
  return items.filter(item => {
    const matchesSearch = /* name, partNumber, manufacturer */;
    const matchesStatus = /* status */;
    const matchesStock = /* OK / LOW / CRITICAL */;
    const matchesType = /* 3-letter prefix */;
    return matchesSearch && matchesStatus && matchesStock && matchesType;
  });
}, [items, searchQuery, selectedStatus, selectedStockStatus, selectedItemType]);
```

### Custom Event Communication

Deeply nested components dispatch custom DOM events to avoid prop-drilling.

```typescript
// Sidebar.tsx
window.dispatchEvent(new CustomEvent('switch-inventory-tab', { detail: 'bom_manager' }));

// App.tsx
useEffect(() => {
  const handler = (e: Event) => setSelectedTableTab((e as CustomEvent).detail);
  window.addEventListener('switch-inventory-tab', handler);
  return () => window.removeEventListener('switch-inventory-tab', handler);
}, []);
```

### Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Cmd+K` / `Ctrl+K` | Focus the global search input |

### Database Seeding

On first boot, `ensureSchema()` in `src/lib/db.ts` creates the `inventory` table if absent, then `seedTable()` reads each CSV in `assets/` (semicolon-delimited for inventory/BOM, comma-delimited for suppliers/projects), infers column types (PK, INTEGER, status CHECK), and upserts rows. Existing tables are truncated and reseeded, so a fresh database is always reproducible.

---

## Key Algorithms

### Stock Health Classification

```typescript
const lowStockCount = items.filter(i => i.stockLevel >= 19 && i.stockLevel < 49).length;
const criticalCount = items.filter(i => i.stockLevel < 19).length;
const okCount = Math.max(0, totalItemsCount - lowStockCount - criticalCount);
```

### Type Prefix Extraction

```typescript
const itemPrefix = item.partNumber?.split('-')[0]?.toUpperCase() || '';
const matchesType = selectedItemType === 'ALL' || itemPrefix === selectedItemType;
```

### Imperial/Metric Conversion

`ItemDetailModal` exports helpers for dimensional conversion:

```typescript
import { deriveMetric, deriveImperial } from './components/ItemDetailModal';

const metric = deriveMetric('0603');    // → "1608"
const imperial = deriveImperial('1608'); // → "0603"
```

### Kit Booking Audit

`auditKitStock(projectId, buildQty)` aggregates BOM quantities per `stockCode`, multiplies by `buildQty`, and checks on-hand `stock`. If short, it consults `alternative_components` for an approved alternate with sufficient stock, then reports `shortage_qty` per component. `kit-booking/execute` runs this inside a DB transaction and rolls back if any shortage remains.

---

## Troubleshooting

### `DATABASE_URL is required`

The API refuses to start without a PostgreSQL connection string. Set `DATABASE_URL` in `.env` (Neon serverless URLs work directly with `pg`).

### HMR Not Working in AI Studio

The Vite config disables HMR when `DISABLE_HMR=true` is set, preventing flicker during agent edits. If you see no hot reload locally, ensure this flag is unset.

### TypeScript Errors After Dependency Updates

Run `npm run lint`. The project uses `skipLibCheck: true` but enforces strict checks on application code.

### CSV Import Failures

Bulk import requires semicolon-delimited rows whose header matches the `ItemSchema` column order. Malformed rows are rejected by Zod with a `details` field rather than silently skipped.

### Build Size Optimization

The production build tree-shakes unused icons from `lucide-react`. Review `src/App.tsx` and view files for unused imports if bundle size becomes a concern.

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/advanced-module`)
3. Commit your changes (`git commit -m 'feat: add advanced module'`)
4. Push to the branch (`git push origin feature/advanced-module`)
5. Open a Pull Request

---

## License

Copyright 2024 Tracklab IM Contributors. Licensed under the **Apache License, Version 2.0** (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at:

[http://www.apache.org/licenses/LICENSE-2.0](http://www.apache.org/licenses/LICENSE-2.0)

Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
