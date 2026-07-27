# Tracklab IM - Enterprise Inventory Management System

A comprehensive inventory management and ERP solution with advanced invoicing, purchase orders, production management, and financial reporting.

## System Overview

Tracklab IM is an enterprise-grade inventory management platform designed to handle:
- **Inventory Management** - Stock tracking, low-stock alerts, item categorization
- **Bookkeeping & Invoicing** - Professional invoice generation with line items, tax calculation, and payment tracking
- **Purchase Orders** - Flexible supplier and customer ordering with conditional item filtering
- **Production Management** - Job cards, work orders, QC checkpoints, defect tracking
- **Financial Reporting** - Chart of accounts, journal entries, general ledger, financial statements
- **Quality & Compliance** - QA inspections, NCRs, defect tracking, supplier intelligence

---

## Invoicing System

### Overview
The invoicing system provides professional invoice generation with:
- ✅ Smart autocomplete for items with automatic cost allocation
- ✅ Modern card-based line items UI (redesigned from tables)
- ✅ Real-time tax calculation
- ✅ Production product support
- ✅ Warranty claim feature to void pricing
- ✅ Print-ready finalization

### Key Features

#### 1. Smart Item Autocomplete
When adding line items to an invoice:
- **Search by SKU or Part Number** - Type to search inventory
- **Auto-populate Details** - Selecting an item automatically fills part number, description, and unit price
- **Dynamic Filtering** - Results update as you type
- **Smart Selection** - Click to select from dropdown

#### 2. Card-Based Line Items UI
- Modern, spacious card design for each line item
- Line number, remove button, SKU/Part # with autocomplete
- Description, quantity, unit price, tax rate selector
- Line total and subtotal + tax breakdown

#### 3. Production Products
- Invoices can include production/manufacturing items
- Endpoint: `/api/items/products`
- Maps model number to part number, selling price to unit price

#### 4. Warranty Claims
- Toggle "Warranty Claim" on invoice to void all pricing (R0.00)
- Shows indicator message "Warranty claim - pricing voided"
- For warranty replacement invoices with no charge

#### 5. Finalization & Print
- Button changed from "Finalize & Send" to "Finalize & Print"
- Prepares invoice for printing/PDF export
- Locks invoice from further editing

---

## Purchase Orders

### Modes: Supplier vs Customer

Purchase Orders support two distinct modes with conditional item filtering:

#### Supplier Mode
- **Use Case**: Ordering inventory/components from external suppliers
- **Items Shown**: Regular inventory items (non-production stock)
- **Supplier List**: Mouser, Digikey, LCSC, Heilind Industrial, RS Components

#### Customer Mode
- **Use Case**: Orders from customers for production/custom items
- **Items Shown**: Production stock items
- **Customer List**: Bokpoort, Damlaagte, Gravitas, DEWA, Sasol, Zwemkuil, Nurfcor, Millvale, Ferrero

### Feature Comparison

| Feature | Supplier Mode | Customer Mode |
|---------|---------------|---------------|
| Partner Type | Supplier | Customer |
| Item Filter | Regular inventory | Production stock |
| Use Case | Component ordering | Customer orders |
| Status | DRAFT, SENT, PARTIAL, RECEIVED, CANCELLED | Same |

### Creating a Purchase Order

1. Click "New Purchase Order"
2. Select Order Type - Supplier or Customer (dropdown updates automatically)
3. Fill Details - Select partner, order date, expected date
4. Add Line Items - Use SKU autocomplete, quantity, unit price, tax rate
5. Save - "Save Draft" or "Save & Send"

---

## Customer Management

### Customers
- Bokpoort
- Damlaagte
- Gravitas
- DEWA
- Sasol
- Zwemkuil
- Nurfcor
- Millvale
- Ferrero

Each customer includes: name, contact, email, phone, address, VAT number, status

---

## Supplier Management

### Suppliers
- MOUSER ELECTRONICS
- DIGIKEY
- LCSC ELECTRONICS
- HEILIND INDUSTRIAL
- RS COMPONENTS

Each supplier includes: name, contact, email, phone, address, VAT number, status

---

## Activity Logging

### Features
- Fire-and-forget async logging pattern
- JSON error handling with try-catch safety
- Multiple IP detection methods (x-forwarded-for, cf-connecting-ip, x-real-ip)

### Logs
- Project creation/deletion
- Invoice creation/finalization
- Purchase order submissions
- User logins/logouts
- System errors and warnings

---

## Error Handling

### Error Boundary
- React Error Boundary wraps invoice line items editor
- Prevents entire page crash if component fails
- Shows graceful error message with details

### Activity Logging Safety
- Non-blocking error logging
- Errors in logging don't crash operations
- Failed logs don't affect invoice/PO creation

---

## Database Schema

#### Customers Table
```sql
CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  customer_name TEXT NOT NULL UNIQUE,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  vat_number TEXT,
  status TEXT DEFAULT 'ACTIVE',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

#### Suppliers Table
```sql
CREATE TABLE suppliers (
  id SERIAL PRIMARY KEY,
  supplier_name TEXT NOT NULL UNIQUE,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  vat_number TEXT,
  status TEXT DEFAULT 'ACTIVE',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## API Endpoints

### Customers
- `GET /api/clients` - List all customers
- `POST /api/clients` - Create customer
- `PUT /api/clients/:id` - Update customer
- `DELETE /api/clients/:id` - Delete customer

### Invoices
- `GET /api/invoices` - List invoices
- `POST /api/invoices` - Create invoice
- `PUT /api/invoices/:id` - Update invoice

### Purchase Orders
- `GET /api/purchase-orders` - List POs
- `POST /api/purchase-orders` - Create PO
- `PUT /api/purchase-orders/:id` - Update PO

### Bootstrap
- `GET /api/bootstrap` - Load all system data

---

## Technology Stack

### Frontend
- React 18.3.1
- Vite
- TypeScript
- Lucide Icons
- Tailwind CSS

### Backend
- Express.js
- TypeScript
- PostgreSQL (Neon Serverless)
- Zod (Schema validation)

### Deployment
- Fly.io
- GitHub Actions
- Docker

---

## Quick Start

### Development
```bash
npm install
npm run dev
npm run build
```

### Production
```bash
git push  # Triggers GitHub Actions
# Deployment via Fly.io
```

---

## Version History

### Current Release
- ✅ Complete invoicing system redesign
- ✅ Customer/Supplier mode switching for POs
- ✅ Production product support
- ✅ Warranty claim feature
- ✅ Modern card-based UI
- ✅ Smart autocomplete
- ✅ Activity logging with error handling
- ✅ Error boundary protection
- ✅ Renamed clients → customers throughout system

---

## License

© 2026 Tracklab IM - All rights reserved
