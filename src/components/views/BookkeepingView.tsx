import React, { useCallback, useEffect, useState } from 'react';
import { LayoutDashboard, Users, ShoppingCart, Receipt, Wallet, Truck, FileText, CreditCard, Landmark, Wrench, BarChart3, Loader2 } from 'lucide-react';
import {
  Client, ClientOrder, ClientOrderItem, BuildJob, BomStructure, SubAssembly, FieldedAsset, StockLedgerEntry,
  Item, Supplier, Account, TaxRate, Invoice, PaymentReceived, PurchaseOrder, Bill, PaymentMade, Expense, BookkeepingBootstrap,
} from '../../types';
import { apiGet } from '../bookkeeping/shared';
import { OverviewTab } from '../bookkeeping/OverviewTab';
import { CustomersTab } from '../bookkeeping/CustomersTab';
import { SalesOrdersTab } from '../bookkeeping/SalesOrdersTab';
import { InvoicesTab } from '../bookkeeping/InvoicesTab';
import { PaymentsReceivedTab } from '../bookkeeping/PaymentsReceivedTab';
import { VendorsTab } from '../bookkeeping/VendorsTab';
import { PurchaseOrdersTab } from '../bookkeeping/PurchaseOrdersTab';
import { BillsTab } from '../bookkeeping/BillsTab';
import { PaymentsMadeTab } from '../bookkeeping/PaymentsMadeTab';
import { ExpensesTab } from '../bookkeeping/ExpensesTab';
import { AccountingTab } from '../bookkeeping/AccountingTab';
import { ProductionTab } from '../bookkeeping/ProductionTab';
import { ReportsTab } from '../bookkeeping/ReportsTab';
import { DispatchTab } from '../bookkeeping/DispatchTab';

interface BookkeepingViewProps {
  clients: Client[];
  setClients: React.Dispatch<React.SetStateAction<Client[]>>;
  clientOrders: ClientOrder[];
  setClientOrders: React.Dispatch<React.SetStateAction<ClientOrder[]>>;
  clientOrderItems: ClientOrderItem[];
  setClientOrderItems: React.Dispatch<React.SetStateAction<ClientOrderItem[]>>;
  buildJobs: BuildJob[];
  setBuildJobs: React.Dispatch<React.SetStateAction<BuildJob[]>>;
  bomStructures: BomStructure[];
  setBomStructures: React.Dispatch<React.SetStateAction<BomStructure[]>>;
  subAssemblies: SubAssembly[];
  setSubAssemblies: React.Dispatch<React.SetStateAction<SubAssembly[]>>;
  fieldedAssets: FieldedAsset[];
  setFieldedAssets: React.Dispatch<React.SetStateAction<FieldedAsset[]>>;
  stockLedgerEntries: StockLedgerEntry[];
  setStockLedgerEntries: React.Dispatch<React.SetStateAction<StockLedgerEntry[]>>;
  items: Item[];
  suppliers: Supplier[];
  triggerToast: (message: string, type?: 'SUCCESS' | 'ERROR' | 'INFO') => void;
  /** When the command palette targets a specific tab, App passes it through
   * here. pendingTargetKey changes on every navigation so the effect below
   * re-fires even if the section is the same as last time. */
  initialSection?: Section;
  initialSalesSub?: SalesSub;
  initialPurchasesSub?: PurchasesSub;
  pendingTargetKey?: string | null;
}

type Section = 'OVERVIEW' | 'SALES' | 'PURCHASES' | 'ACCOUNTING' | 'PRODUCTION' | 'REPORTS';
type SalesSub = 'CUSTOMERS' | 'ORDERS' | 'INVOICES' | 'PAYMENTS' | 'DISPATCH';
type PurchasesSub = 'VENDORS' | 'ORDERS' | 'BILLS' | 'PAYMENTS' | 'EXPENSES';

const SECTIONS: { key: Section; label: string; icon: React.ReactNode }[] = [
  { key: 'OVERVIEW', label: 'Overview', icon: <LayoutDashboard className="w-4 h-4" /> },
  { key: 'SALES', label: 'Sales', icon: <Receipt className="w-4 h-4" /> },
  { key: 'PURCHASES', label: 'Purchases', icon: <ShoppingCart className="w-4 h-4" /> },
  { key: 'ACCOUNTING', label: 'Accounting', icon: <Landmark className="w-4 h-4" /> },
  { key: 'PRODUCTION', label: 'Production', icon: <Wrench className="w-4 h-4" /> },
  { key: 'REPORTS', label: 'Reports', icon: <BarChart3 className="w-4 h-4" /> },
];

const SALES_SUBS: { key: SalesSub; label: string; icon: React.ReactNode }[] = [
  { key: 'CUSTOMERS', label: 'Customers', icon: <Users className="w-3.5 h-3.5" /> },
  { key: 'ORDERS', label: 'Sales Orders', icon: <FileText className="w-3.5 h-3.5" /> },
  { key: 'INVOICES', label: 'Invoices', icon: <Receipt className="w-3.5 h-3.5" /> },
  { key: 'PAYMENTS', label: 'Payments Received', icon: <Wallet className="w-3.5 h-3.5" /> },
  { key: 'DISPATCH', label: 'Delivery & Collection', icon: <Truck className="w-3.5 h-3.5" /> },
];

const PURCHASES_SUBS: { key: PurchasesSub; label: string; icon: React.ReactNode }[] = [
  { key: 'VENDORS', label: 'Vendors', icon: <Truck className="w-3.5 h-3.5" /> },
  { key: 'ORDERS', label: 'Purchase Orders', icon: <FileText className="w-3.5 h-3.5" /> },
  { key: 'BILLS', label: 'Bills', icon: <Receipt className="w-3.5 h-3.5" /> },
  { key: 'PAYMENTS', label: 'Payments Made', icon: <CreditCard className="w-3.5 h-3.5" /> },
  { key: 'EXPENSES', label: 'Expenses', icon: <Wallet className="w-3.5 h-3.5" /> },
];

export const BookkeepingView: React.FC<BookkeepingViewProps> = ({
  clients, clientOrders, clientOrderItems, items, suppliers, triggerToast,
  initialSection, initialSalesSub, initialPurchasesSub, pendingTargetKey,
}) => {
  const [section, setSection] = useState<Section>(initialSection ?? 'OVERVIEW');
  const [salesSub, setSalesSub] = useState<SalesSub>(initialSalesSub ?? 'INVOICES');
  const [purchasesSub, setPurchasesSub] = useState<PurchasesSub>(initialPurchasesSub ?? 'BILLS');

  // Sync with palette-driven navigation. Sub-tab keys only apply within their
  // own section, so we ignore initialSalesSub when the target isn't SALES.
  useEffect(() => {
    if (!pendingTargetKey) return;
    if (initialSection) setSection(initialSection);
    if (initialSection === 'SALES' && initialSalesSub) setSalesSub(initialSalesSub);
    if (initialSection === 'PURCHASES' && initialPurchasesSub) setPurchasesSub(initialPurchasesSub);
  }, [pendingTargetKey, initialSection, initialSalesSub, initialPurchasesSub]);

  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [taxRates, setTaxRates] = useState<TaxRate[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [paymentsReceived, setPaymentsReceived] = useState<PaymentReceived[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [bills, setBills] = useState<Bill[]>([]);
  const [paymentsMade, setPaymentsMade] = useState<PaymentMade[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [productionItems, setProductionItems] = useState<Item[]>([]);

  const [prefillFromPO, setPrefillFromPO] = useState<PurchaseOrder | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data: BookkeepingBootstrap = await apiGet('/api/bookkeeping/bootstrap');
      setAccounts(data.accounts);
      setTaxRates(data.taxRates);
      setInvoices(data.invoices);
      setPaymentsReceived(data.paymentsReceived);
      setPurchaseOrders(data.purchaseOrders);
      setBills(data.bills);
      setPaymentsMade(data.paymentsMade);
      setExpenses(data.expenses);

      // Load production items for invoicing
      try {
        const prodItems = await apiGet('/api/items/products');
        setProductionItems(prodItems);
      } catch (err: any) {
        console.warn('Could not load production items, using regular items:', err.message);
        // Fall back to regular items - they'll be used if productionItems is empty
      }
    } catch (err: any) {
      triggerToast(err.message || 'Failed to load bookkeeping data', 'ERROR');
    } finally {
      setLoading(false);
    }
  }, [triggerToast]);

  // Load once on mount. Children call `refresh()` explicitly after mutations
  // (invoice created, bill saved etc). Depending on `refresh` here would loop:
  // triggerToast is a new function on every App render, so refresh's identity
  // churns, useEffect fires, /api/bookkeeping/bootstrap gets hammered, and
  // Fly's proxy starts aborting requests — the "failed to fetch" the user saw.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { refresh(); }, []);

  const moduleData = {
    accounts, taxRates, invoices, paymentsReceived, purchaseOrders, bills, paymentsMade, expenses,
    clients, suppliers, items: productionItems.length > 0 ? productionItems : items, clientOrders, triggerToast, refresh,
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-on-surface-variant">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading bookkeeping data...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-headline-sm text-xl font-black text-on-surface tracking-tighter mb-1">Bookkeeping</h3>
        <p className="text-xs text-on-surface-variant">Double-entry accounting, invoicing, bills, and financial reporting.</p>
      </div>

      <div className="flex gap-1 overflow-x-auto pb-1">
        {SECTIONS.map(s => (
          <button
            key={s.key}
            onClick={() => setSection(s.key)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold whitespace-nowrap transition-all ${section === s.key ? 'bg-primary text-white' : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high border border-outline-variant'}`}
          >
            {s.icon}{s.label}
          </button>
        ))}
      </div>

      {section === 'OVERVIEW' && <OverviewTab {...moduleData} />}

      {section === 'SALES' && (
        <div className="space-y-4">
          <div className="flex gap-1 bg-surface-container-high/40 p-1 rounded-lg w-fit overflow-x-auto">
            {SALES_SUBS.map(s => (
              <button key={s.key} onClick={() => setSalesSub(s.key)} className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-bold whitespace-nowrap transition-all ${salesSub === s.key ? 'bg-primary text-white' : 'text-on-surface-variant hover:text-on-surface'}`}>
                {s.icon}{s.label}
              </button>
            ))}
          </div>
          {salesSub === 'CUSTOMERS' && <CustomersTab {...moduleData} />}
          {salesSub === 'ORDERS' && <SalesOrdersTab {...moduleData} />}
          {salesSub === 'INVOICES' && <InvoicesTab {...moduleData} />}
          {salesSub === 'PAYMENTS' && <PaymentsReceivedTab {...moduleData} />}
          {salesSub === 'DISPATCH' && <DispatchTab {...moduleData} />}
        </div>
      )}

      {section === 'PURCHASES' && (
        <div className="space-y-4">
          <div className="flex gap-1 bg-surface-container-high/40 p-1 rounded-lg w-fit overflow-x-auto">
            {PURCHASES_SUBS.map(s => (
              <button key={s.key} onClick={() => setPurchasesSub(s.key)} className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-bold whitespace-nowrap transition-all ${purchasesSub === s.key ? 'bg-primary text-white' : 'text-on-surface-variant hover:text-on-surface'}`}>
                {s.icon}{s.label}
              </button>
            ))}
          </div>
          {purchasesSub === 'VENDORS' && <VendorsTab {...moduleData} />}
          {purchasesSub === 'ORDERS' && (
            <PurchaseOrdersTab
              {...moduleData}
              onConvertToBill={(po) => {
                setPrefillFromPO(po);
                setPurchasesSub('BILLS');
              }}
            />
          )}
          {purchasesSub === 'BILLS' && (
            <BillsTab
              {...moduleData}
              prefillFromPO={prefillFromPO}
              onPrefillConsumed={() => setPrefillFromPO(null)}
            />
          )}
          {purchasesSub === 'PAYMENTS' && <PaymentsMadeTab {...moduleData} />}
          {purchasesSub === 'EXPENSES' && <ExpensesTab {...moduleData} />}
        </div>
      )}

      {section === 'ACCOUNTING' && <AccountingTab {...moduleData} />}
      {section === 'PRODUCTION' && <ProductionTab {...moduleData} />}
      {section === 'REPORTS' && <ReportsTab {...moduleData} />}
    </div>
  );
};
