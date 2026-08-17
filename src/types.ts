export interface Item {
  partNumber: string; // serial_number
  name: string;
  description: string;
  manufacturer: string;
  stockLevel: number; // stock
  price: number; // current_cost_dollar or bulk_price_usd
  category: string; // type/category
  status: 'ACTIVE' | 'INACTIVE' | 'BOOKED OUT' | 'DISCONTINUED';
  supplier?: string;

  // Rich CSV properties
  value?: string;
  size?: string;
  sizeMetric?: string;
  packageName?: string; // package
  tolerance?: string;
  itemType?: string; // Component, Consumable, Product, Sub-Assembly, Tool
  footprint?: string;
  comment?: string;
  datasheet?: string;
  project?: string;
  packaging?: string;
  packagingQuantity?: number; // e.g. 1, 5, 10, 50
  packagingType?: string; // packet, reel, tray, box, pallet, tube, strip, bulk
  lowStockLvl?: number;
  bulkPriceUsd?: number;
  bulkPriceZar?: number;
  lastOrderQty?: number;
  lastOrderDate?: string;
  manPns?: string[]; // man_pn_1 to man_pn_5
  supPns?: string[]; // sup_pn_1 to sup_pn_5
  weblinks?: string[]; // weblink_1 to weblink_5
}

export interface Transaction {
  id: string;
  itemPartNumber: string;
  itemName: string;
  type: 'INBOUND' | 'OUTBOUND' | 'TRANSFER' | 'BOOK-IN' | 'BOOK-OUT';
  qtyChange: number;
  reference: string;
  performedBy: string;
  performedByAvatar?: string;
  dateTime: string;
  newCost?: number; // Added for Book-In tracking
}

export interface Supplier {
  id: string;
  name: string;
  website: string;
  contact_email: string;
  notes: string;
  leadTime?: number;
  responseTime?: number;
}

export interface ProductionKit {
  kitId: string;
  skuReference: string;
  status: 'READY' | 'STAGING' | 'BLOCKED' | 'ACTIVE';
  qtyAvailable: number;
  assemblyLine: string;
  lastUpdated: string;
  projectId?: number;
}

export interface Project {
  id: number;
  projectName: string;
  description: string;
  status: string;
  createdDate: string;
  startDate?: string;
  endDate?: string;
  assignedTeam?: string;
  designSpecs?: string;
}

export interface BOMItem {
  id: string;
  projectId: number;
  stockCode: string; // matches item's partNumber
  comment: string;
  description: string;
  designator: string;
  footprint: string;
  libref: string;
  quantity: number; // Qty per board
}

export interface PickPlaceItem {
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

export interface JobCard {
  id: number;
  projectId: number;
  buildQty: number;
  status: string;
  createdAt: string;
  assignedTeam?: string;
}

export interface Client {
  id: number;
  clientName: string;
  contactName?: string;
  email?: string;
  phone?: string;
  address?: string;
  vatNumber?: string;
  status: string;
  createdAt: string;
}

export interface ClientOrder {
  id: number;
  clientId?: number;
  orderNumber: string;
  orderDate: string;
  requiredDate?: string;
  status: string;
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
  notes?: string;
  createdAt: string;
}

export interface ClientOrderItem {
  id: number;
  clientOrderId?: number;
  partNumber?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  createdAt: string;
}

export interface BuildJob {
  id: number;
  clientOrderId?: number;
  jobNumber: string;
  status: string;
  buildQty: number;
  startDate?: string;
  endDate?: string;
  assignedTeam?: string;
  notes?: string;
  createdAt: string;
}

export interface BomStructure {
  id: number;
  parentPartNumber: string;
  childPartNumber: string;
  quantity: number;
  description?: string;
  createdAt: string;
}

export interface SubAssembly {
  id: number;
  assemblyName: string;
  parentPartNumber?: string;
  childPartNumber?: string;
  quantity: number;
  description?: string;
  createdAt: string;
}

export interface FieldedAsset {
  id: number;
  clientId?: number;
  assetTag: string;
  serialNumber?: string;
  installedDate?: string;
  status: string;
  location?: string;
  notes?: string;
  createdAt: string;
}

export interface StockLedgerEntry {
  id: number;
  itemSerialNumber?: string;
  movementType: string;
  quantity: number;
  movementDate: string;
  reference?: string;
  notes?: string;
  createdAt: string;
}

// ============================================================================
// BOOKKEEPING / ERP MODULE — Chart of Accounts, double-entry ledger, AR/AP
// ============================================================================

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';
export type NormalBalance = 'DEBIT' | 'CREDIT';

export interface Account {
  id: number;
  code: string;
  name: string;
  type: AccountType;
  subtype?: string;
  normalBalance: NormalBalance;
  description?: string;
  isSystem: boolean;
  isActive: boolean;
  createdAt: string;
}

export interface TaxRate {
  id: number;
  name: string;
  rate: number; // percentage, e.g. 15
  isDefault: boolean;
  createdAt: string;
}

export interface JournalEntry {
  id: number;
  entryNumber: string;
  entryDate: string;
  memo?: string;
  sourceType: 'INVOICE' | 'BILL' | 'PAYMENT_RECEIVED' | 'PAYMENT_MADE' | 'EXPENSE' | 'MANUAL' | 'REVERSAL';
  sourceId?: number;
  status: 'POSTED' | 'VOID';
  createdAt: string;
  lines?: JournalLine[];
  totalDebit?: number;
  totalCredit?: number;
}

export interface JournalLine {
  id: number;
  journalEntryId: number;
  accountId: number;
  accountCode?: string;
  accountName?: string;
  debit: number;
  credit: number;
  description?: string;
  entityType?: 'CUSTOMER' | 'SUPPLIER';
  entityId?: number;
}

export type DocLineItem = {
  id: number;
  partNumber?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRateId?: number;
  taxAmount: number;
  lineTotal: number;
};

export interface InvoiceItem extends DocLineItem {
  invoiceId: number;
  deductStock: boolean;
}

export type InvoiceStatus = 'DRAFT' | 'SENT' | 'PARTIAL' | 'PAID' | 'OVERDUE' | 'VOID';

export interface Invoice {
  id: number;
  invoiceNumber: string;
  clientId?: number;
  clientOrderId?: number;
  invoiceDate: string;
  dueDate?: string;
  status: InvoiceStatus;
  currency: string;
  subtotal: number;
  taxTotal: number;
  discountTotal: number;
  total: number;
  amountPaid: number;
  balanceDue: number;
  notes?: string;
  terms?: string;
  isWarrantyClaim?: boolean;
  journalEntryId?: number;
  createdAt: string;
  updatedAt?: string;
  items?: InvoiceItem[];
  clientName?: string;
}

export type DispatchNoteType = 'DELIVERY' | 'COLLECTION';
export type DispatchNoteStatus = 'DRAFT' | 'ISSUED' | 'COMPLETED' | 'CANCELLED';

export interface DispatchNoteItem {
  id: number;
  dispatchNoteId?: number;
  partNumber?: string;
  description: string;
  quantity: number;
  serialNumbers?: string;
}

export interface DispatchNote {
  id: number;
  noteNumber: string;
  noteType: DispatchNoteType;
  clientId?: number;
  clientOrderId?: number;
  invoiceId?: number;
  noteDate: string;
  scheduledDate?: string;
  status: DispatchNoteStatus;
  contactPerson?: string;
  address?: string;
  carrier?: string;
  reference?: string;
  notes?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt?: string;
  clientName?: string;
  orderNumber?: string;
  invoiceNumber?: string;
  items?: DispatchNoteItem[];
}

export interface PaymentAllocation {
  id: number;
  paymentId: number;
  invoiceId: number;
  amountApplied: number;
  invoiceNumber?: string;
}

export interface PaymentReceived {
  id: number;
  paymentNumber: string;
  clientId?: number;
  paymentDate: string;
  amount: number;
  unallocatedAmount: number;
  method: string;
  depositAccountId?: number;
  reference?: string;
  notes?: string;
  journalEntryId?: number;
  createdAt: string;
  allocations?: PaymentAllocation[];
  clientName?: string;
}

export interface PurchaseOrderItem extends DocLineItem {
  purchaseOrderId: number;
  qtyReceived: number;
}

export type PurchaseOrderStatus = 'DRAFT' | 'SENT' | 'PARTIAL' | 'RECEIVED' | 'CANCELLED';

export interface PurchaseOrder {
  id: number;
  poNumber: string;
  supplierId?: string;
  orderDate: string;
  expectedDate?: string;
  status: PurchaseOrderStatus;
  currency: string;
  subtotal: number;
  taxTotal: number;
  total: number;
  notes?: string;
  createdAt: string;
  items?: PurchaseOrderItem[];
  supplierName?: string;
}

export interface BillItem extends DocLineItem {
  billId: number;
  accountId?: number;
  receiveStock: boolean;
}

export type BillStatus = 'DRAFT' | 'AWAITING_PAYMENT' | 'PARTIAL' | 'PAID' | 'OVERDUE' | 'VOID';

export interface Bill {
  id: number;
  billNumber: string;
  supplierId?: string;
  purchaseOrderId?: number;
  billDate: string;
  dueDate?: string;
  status: BillStatus;
  currency: string;
  subtotal: number;
  taxTotal: number;
  total: number;
  amountPaid: number;
  balanceDue: number;
  notes?: string;
  journalEntryId?: number;
  /** Base64 data URL of the scanned till slip / vendor invoice, if attached. */
  receiptImage?: string | null;
  createdAt: string;
  updatedAt?: string;
  items?: BillItem[];
  supplierName?: string;
}

export interface PaymentMadeAllocation {
  id: number;
  paymentId: number;
  billId: number;
  amountApplied: number;
  billNumber?: string;
}

export interface PaymentMade {
  id: number;
  paymentNumber: string;
  supplierId?: string;
  paymentDate: string;
  amount: number;
  unallocatedAmount: number;
  method: string;
  paidFromAccountId?: number;
  reference?: string;
  notes?: string;
  journalEntryId?: number;
  createdAt: string;
  allocations?: PaymentMadeAllocation[];
  supplierName?: string;
}

export interface Expense {
  id: number;
  expenseNumber: string;
  expenseDate: string;
  payee?: string;
  supplierId?: string;
  categoryAccountId?: number;
  paidFromAccountId?: number;
  amount: number;
  taxRateId?: number;
  taxAmount: number;
  total: number;
  reference?: string;
  notes?: string;
  status: 'RECORDED' | 'VOID';
  journalEntryId?: number;
  createdAt: string;
  categoryAccountName?: string;
  paidFromAccountName?: string;
}

export interface TrialBalanceRow {
  accountId: number;
  code: string;
  name: string;
  type: AccountType;
  debit: number;
  credit: number;
}

export interface ProfitLossReport {
  from: string;
  to: string;
  income: { accountId: number; code: string; name: string; amount: number }[];
  expenses: { accountId: number; code: string; name: string; amount: number }[];
  totalIncome: number;
  totalExpenses: number;
  netProfit: number;
}

export interface BalanceSheetReport {
  asOf: string;
  assets: { accountId: number; code: string; name: string; amount: number }[];
  liabilities: { accountId: number; code: string; name: string; amount: number }[];
  equity: { accountId: number; code: string; name: string; amount: number }[];
  currentEarnings: number;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
}

export interface AgingRow {
  entityId: number | string;
  entityName: string;
  current: number;
  d30: number;
  d60: number;
  d90: number;
  d90plus: number;
  total: number;
}

export interface BookkeepingBootstrap {
  accounts: Account[];
  taxRates: TaxRate[];
  invoices: Invoice[];
  paymentsReceived: PaymentReceived[];
  purchaseOrders: PurchaseOrder[];
  bills: Bill[];
  paymentsMade: PaymentMade[];
  expenses: Expense[];
}

export interface UserProfile {
  name: string;
  role: string;
  opId: string;
  clearanceLevel: number;
  bio: string;
  avatarUrl: string;
  email: string;
  timezone: string;
}

export interface SystemConfig {
  appName: string;
  defaultLanguage: string;
  timezone: string;
  connectionString: string;
  syncFrequency: 'LIVE' | 'INTV';
  autoStatusSync: boolean;
  lowStockAlert: boolean;
  systemLatencyWarning: boolean;
  transactionSummaries: boolean;
  visualTheme: 'dark' | 'light';
  highDensityMode: boolean;
  primaryTint: string;
}

export type ViewType =
  | 'dashboard'
  | 'items'
  | 'stock_kits'
  | 'reports_ledger'
  | 'pricing'
  | 'suppliers'
  | 'settings'
  | 'search'
  | 'profile'
  | 'activity-logs'
  | 'bom_manager'
  | 'pick_place'
  | 'alternates'
  | 'bulk_pricing'
  | 'production_kits'
  | 'kit_booking'
  | 'projects'
  | 'production_costs'
  | 'bookkeeping'
  | 'automation'
  | 'auto_po_config'
  | 'quality_compliance'
  | 'advanced_automation';

export interface ProductionProduct {
  id: number;
  modelNumber: string;
  description?: string;
  category?: string;
  productionCost: number | null;
  sellingPrice: number | null;
  currency: string;
  notes?: string;
  margin: number | null;
  marginPct: number | null;
  createdAt: string;
  updatedAt?: string;
}

// ============================================================================
// AUTOMATION & WORKFLOW MANAGEMENT
// ============================================================================

// Single source of truth lives in ./lib/automationStates as `enum` — import
// + re-export so this file uses them as types too. Using the same identifier
// as the enum means these behave as both value and type (an enum is both).
import { AutomationRuleState, ScheduledJobState } from './lib/automationStates';
export { AutomationRuleState, ScheduledJobState };
export type NotificationState = 'PENDING' | 'SENT' | 'FAILED' | 'READ' | 'ARCHIVED';
export type EventState = 'CREATED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'RETRYING';
export type AutomationTriggerType = 'MANUAL' | 'SCHEDULED' | 'EVENT_BASED' | 'WEBHOOK' | 'API';
export type AutomationActionType = 'CREATE_PO' | 'SEND_EMAIL' | 'UPDATE_INVENTORY' | 'CREATE_ALERT' | 'RUN_REPORT' | 'WEBHOOK_CALL' | 'CUSTOM_SCRIPT';

export interface AutomationRule {
  id?: number;
  name: string;
  description?: string;
  triggerType: AutomationTriggerType;
  triggerConfig: Record<string, any>;
  actions: AutomationAction[];
  conditions?: Record<string, any>;
  isActive: boolean;
  state: AutomationRuleState;
  executionCount?: number;
  lastExecuted?: string;
  nextExecution?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface AutomationAction {
  id?: number;
  type: AutomationActionType;
  config: Record<string, any>;
  order: number;
  enabled?: boolean;
}

export interface ScheduledJob {
  id?: number;
  name: string;
  description?: string;
  state: ScheduledJobState;
  schedulePattern: string; // Cron expression or ISO interval
  automationRuleId?: number;
  lastRun?: string;
  nextRun?: string;
  executionCount?: number;
  failureCount?: number;
  lastError?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Notification {
  id?: number;
  type: string;
  state: NotificationState;
  recipient: string;
  subject: string;
  message: string;
  data?: Record<string, any>;
  readAt?: string;
  createdAt?: string;
}

export interface EventLog {
  id?: number;
  eventType: string;
  state: EventState;
  source?: string;
  sourceId?: string;
  data?: Record<string, any>;
  error?: string;
  retryCount?: number;
  nextRetry?: string;
  completedAt?: string;
  createdAt?: string;
}

// ============================================================================
// USER MANAGEMENT & AUTHENTICATION
// ============================================================================

export type UserRole = 'admin' | 'manager' | 'viewer';
export type UserStatus = 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';

export interface User {
  id?: number;
  email: string;
  password?: string;
  firstName?: string;
  lastName?: string;
  role: UserRole;
  status: UserStatus;
  createdAt?: string;
  updatedAt?: string;
  lastLogin?: string;
}

export interface RolePermission {
  role: UserRole;
  permission: string;
  createdAt?: string;
}

export interface UserPermissions {
  role: UserRole;
  permissions: string[];
}

