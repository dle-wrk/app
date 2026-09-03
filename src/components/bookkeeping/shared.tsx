import React from 'react';
import { X, Loader2 } from 'lucide-react';
import { Account, TaxRate, Invoice, PaymentReceived, PurchaseOrder, Bill, PaymentMade, Expense, Client, Supplier, Item, ClientOrder } from '../../types';

export interface ModuleDataProps {
  accounts: Account[];
  taxRates: TaxRate[];
  invoices: Invoice[];
  paymentsReceived: PaymentReceived[];
  purchaseOrders: PurchaseOrder[];
  bills: Bill[];
  paymentsMade: PaymentMade[];
  expenses: Expense[];
  clients: Client[];
  suppliers: Supplier[];
  items: Item[];
  clientOrders: ClientOrder[];
  triggerToast: (msg: string, type?: 'SUCCESS' | 'ERROR' | 'INFO') => void;
  refresh: () => Promise<void>;
  // Optional per-entity setters for optimistic updates. The bookkeeping
  // bootstrap only refetches accounts/invoices/POs/bills/payments/expenses —
  // clients and suppliers are owned by App state, so `refresh()` does NOT
  // update them. Tabs that mutate a client or supplier must call these
  // setters directly (rollback on failure) or the UI stays stale.
  setClients?: React.Dispatch<React.SetStateAction<Client[]>>;
}

// ============================================================================
// FORMATTING HELPERS
// ============================================================================

export function fmtMoney(amount: number | undefined | null, currency: string = 'ZAR'): string {
  const n = Number(amount) || 0;
  const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : 'R';
  const formatted = Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '-' : ''}${symbol}${formatted}`;
}

export function fmtDate(dateStr: string | undefined | null): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return String(dateStr);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDaysISO(days: number, from?: string): string {
  const d = from ? new Date(from) : new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ============================================================================
// FETCH HELPERS
// ============================================================================

export class ApiError extends Error {}

async function handleResponse(res: Response) {
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      message = body.error || message;
    } catch {
      // ignore
    }
    throw new ApiError(message);
  }
  if (res.status === 204) return null;
  return res.json();
}

export async function apiGet(url: string) {
  const res = await fetch(url);
  return handleResponse(res);
}

export async function apiPost(url: string, body?: any) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return handleResponse(res);
}

export async function apiPut(url: string, body?: any) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return handleResponse(res);
}

export async function apiDelete(url: string) {
  const res = await fetch(url, { method: 'DELETE' });
  return handleResponse(res);
}

// ============================================================================
// UI PRIMITIVES (match the existing Tracklab design system)
// ============================================================================

const MODAL_WIDTHS: Record<string, string> = {
  'max-w-sm': '384px', 'max-w-md': '448px', 'max-w-lg': '512px',
  'max-w-xl': '576px', 'max-w-2xl': '672px', 'max-w-3xl': '768px', 'max-w-4xl': '896px',
};
export const Modal: React.FC<{ title: string; subtitle?: string; onClose: () => void; children: React.ReactNode; maxWidth?: string }> = ({ title, subtitle, onClose, children, maxWidth = 'max-w-2xl' }) => {
  // Escape-to-dismiss. Every bookkeeping tab uses this wrapper (bills,
  // invoices, POs, customers, vendors, payments, expenses) so this one
  // handler covers the whole surface. Bookkeeping modals aren't nested,
  // so a single window-level listener is fine — if we ever add nesting
  // we'd need to stack them and only fire the top one.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 bg-background/80 backdrop-blur-xs flex items-center justify-center z-100 p-md" onClick={onClose}>
      <div className="bg-surface-container rounded-xl border border-outline-variant w-full p-lg shadow-2xl relative max-h-[90vh] overflow-y-auto custom-scrollbar" style={{ maxWidth: MODAL_WIDTHS[maxWidth] || maxWidth }} onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} aria-label="Close modal" className="absolute top-sm right-sm text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high p-1.5 rounded-lg transition-colors">
          <X className="w-4 h-4" />
        </button>
        <h4 className="font-headline-sm text-lg font-black text-primary block mb-1 select-none tracking-tighter leading-none">{title}</h4>
        {subtitle && <p className="text-xs text-on-surface-variant mb-md">{subtitle}</p>}
        {!subtitle && <div className="mb-md" />}
        {children}
      </div>
    </div>
  );
};

export const StatCard: React.FC<{ label: string; value: string; accent?: 'primary' | 'secondary' | 'tertiary' | 'error' | 'green'; sub?: string; icon?: React.ReactNode }> = ({ label, value, accent = 'primary', sub, icon }) => {
  const colorClass = accent === 'error' ? 'text-error' : accent === 'green' ? 'text-green-400' : accent === 'secondary' ? 'text-secondary' : accent === 'tertiary' ? 'text-tertiary' : 'text-primary';
  return (
    <div className="bg-surface-container p-md rounded-xl border border-outline-variant hover:border-primary/50 transition-colors relative overflow-hidden">
      <div className="flex items-center justify-between mb-1">
        <span className="text-on-surface-variant text-[11px] font-bold">{label}</span>
        {icon && <span className={colorClass}>{icon}</span>}
      </div>
      <div className={`text-xl font-black ${colorClass}`}>{value}</div>
      {sub && <p className="text-[10px] text-outline mt-1">{sub}</p>}
    </div>
  );
};

const STATUS_STYLES: Record<string, string> = {
  DRAFT: 'bg-surface-container-highest text-on-surface-variant border-outline-variant',
  SENT: 'bg-secondary-container/40 text-secondary border-secondary/20',
  AWAITING_PAYMENT: 'bg-secondary-container/40 text-secondary border-secondary/20',
  PARTIAL: 'bg-tertiary/10 text-tertiary border-tertiary/20',
  PAID: 'bg-green-500/10 text-green-400 border-green-500/20',
  RECEIVED: 'bg-green-500/10 text-green-400 border-green-500/20',
  RECORDED: 'bg-green-500/10 text-green-400 border-green-500/20',
  OVERDUE: 'bg-error/10 text-error border-error/20',
  VOID: 'bg-outline-variant/20 text-outline border-outline-variant line-through',
  CANCELLED: 'bg-outline-variant/20 text-outline border-outline-variant line-through',
  ACTIVE: 'bg-green-500/10 text-green-400 border-green-500/20',
  INACTIVE: 'bg-outline-variant/20 text-outline border-outline-variant',
  POSTED: 'bg-green-500/10 text-green-400 border-green-500/20',
};

export const StatusPill: React.FC<{ status: string }> = ({ status }) => (
  <span className={`inline-block px-2 py-0.5 rounded-full text-[9px] font-bold border whitespace-nowrap ${STATUS_STYLES[status] || 'bg-surface-container-highest text-on-surface-variant border-outline-variant'}`}>
    {status.replace(/_/g, ' ')}
  </span>
);

export const EmptyState: React.FC<{ message: string; colSpan?: number }> = ({ message, colSpan = 6 }) => (
  <tr>
    <td colSpan={colSpan} className="py-8 text-center text-outline text-xs italic">{message}</td>
  </tr>
);

export const LoadingRow: React.FC<{ colSpan?: number }> = ({ colSpan = 6 }) => (
  <tr>
    <td colSpan={colSpan} className="py-8 text-center text-outline text-xs">
      <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" /> Loading...
    </td>
  </tr>
);

export const SectionCard: React.FC<{ title: string; badge?: string; actions?: React.ReactNode; children: React.ReactNode }> = ({ title, badge, actions, children }) => (
  <div className="bg-surface-container rounded-xl border border-outline-variant overflow-hidden">
    <div className="px-lg py-sm border-b border-outline-variant bg-surface-container-high/30 flex justify-between items-center flex-wrap gap-2">
      <div className="flex items-center gap-sm">
        <span className="font-bold text-sm">{title}</span>
        {badge && <span className="text-[10px] text-primary font-bold uppercase tracking-wider bg-primary/10 px-2 py-0.5 rounded">{badge}</span>}
      </div>
      {actions && <div className="flex gap-sm items-center">{actions}</div>}
    </div>
    {children}
  </div>
);

export const PrimaryButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: React.ReactNode }> = ({ icon, children, className = '', ...props }) => (
  <button {...props} className={`inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-white hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed ${className}`}>
    {icon}{children}
  </button>
);

export const SecondaryButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: React.ReactNode }> = ({ icon, children, className = '', ...props }) => (
  <button {...props} className={`inline-flex items-center gap-1.5 rounded-lg bg-surface-container-high border border-outline-variant px-3 py-1.5 text-xs font-bold text-on-surface hover:bg-surface-container-highest transition-all disabled:opacity-40 disabled:cursor-not-allowed ${className}`}>
    {icon}{children}
  </button>
);

export const DangerButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: React.ReactNode }> = ({ icon, children, className = '', ...props }) => (
  <button {...props} className={`inline-flex items-center gap-1.5 rounded-lg bg-error/10 border border-error/30 px-3 py-1.5 text-xs font-bold text-error hover:bg-error/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed ${className}`}>
    {icon}{children}
  </button>
);

export const FieldLabel: React.FC<{ children: React.ReactNode; hint?: string }> = ({ children, hint }) => (
  <label className="block text-xs font-bold text-on-surface-variant mb-1">
    {children}
    {hint && <span className="block text-[10px] text-outline font-medium mt-0.5">{hint}</span>}
  </label>
);

export const inputClass = 'w-full rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2 text-sm text-on-surface focus:outline-none focus:border-primary';
export const selectClass = inputClass;
