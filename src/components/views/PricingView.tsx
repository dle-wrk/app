import React, { useEffect, useState } from 'react';
import { Item, ViewType } from '../../types';
import { ChevronLeft, ChevronRight, Search, Settings, Database } from 'lucide-react';
import BulkPricingWizard from '../BulkPricingWizard';

interface PricingViewProps {
  items: Item[];
  handleUpdateBulkPrices: (prices: { partNumber: string; price: number }[]) => void;
  triggerToast: (msg: string, type?: any) => void;
  pricingFilter: string;
  setPricingFilter: (filter: string) => void;
  setSelectedDetailPartNumber: (partNumber: string | null) => void;
  setView: (view: ViewType) => void;
}

interface ProviderResult {
  partNumber?: string;
  manufacturer?: string;
  unitPrice?: number | null;
  currency?: string | null;
  stock?: number | null;
  productUrl?: string | null;
  updatedAt?: string;
  error?: string;
  distributor?: string;
}

interface SearchResponse {
  partNumber: string;
  digikey?: ProviderResult;
  mouser?: ProviderResult;
  lcsc?: ProviderResult;
  nexar?: ProviderResult;
  element14?: ProviderResult;
  tme?: ProviderResult;
}

interface UsageResponse {
  digikey: { used: number; limit: number; configured: boolean; authorized: boolean };
  mouser: { used: number; limit: number; configured: boolean };
  lcsc: { cached: number; lastUpdated: string | null; liveLookup?: boolean };
  nexar: { used: number; limit: number; configured: boolean };
  element14: { used: number; limit: number; configured: boolean };
  tme: { used: number; limit: number; configured: boolean };
}

// Mirrors GET /api/pricing/keys. `masked` is a redacted preview of a stored
// value — the plaintext credential is never sent to the browser.
interface ProviderKeyField {
  name: string;
  label: string;
  envVar: string;
  type: 'text' | 'password';
  required?: boolean;
  help?: string;
  hasValue: boolean;
  source: 'db' | 'env' | null;
  masked: string;
}

interface ProviderKeyConfig {
  provider: string;
  label: string;
  description: string;
  configured: boolean;
  fields: ProviderKeyField[];
}

function UsageMeter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const nearLimit = pct >= 90;
  return (
    <div>
      <div className="flex justify-between items-center text-[11px] mb-1">
        <span className="text-on-surface-variant">{label}</span>
        <span className={`font-mono font-bold ${nearLimit ? 'text-red-400' : 'text-primary'}`}>{used}/{limit}</span>
      </div>
      <div className="w-full bg-outline-variant/30 h-1.5 rounded-full overflow-hidden">
        <div className={`h-full ${nearLimit ? 'bg-red-500' : 'bg-primary'}`} style={{ width: `${pct}%` }}></div>
      </div>
    </div>
  );
}

function ProviderResultCard({ name, result }: { name: string; result?: ProviderResult }) {
  if (!result) {
    return (
      <div className="bg-surface-container-high/30 p-md rounded-lg border border-outline-variant">
        <span className="text-[10px] font-label-caps text-outline block mb-1">{name}</span>
        <span className="text-xs text-outline">—</span>
      </div>
    );
  }
  if (result.error) {
    return (
      <div className="bg-surface-container-high/30 p-md rounded-lg border border-outline-variant">
        <span className="text-[10px] font-label-caps text-outline block mb-1">{name}</span>
        <span className="text-xs text-red-400">{result.error}</span>
      </div>
    );
  }
  return (
    <div className="bg-surface-container-high/30 p-md rounded-lg border border-outline-variant">
      <span className="text-[10px] font-label-caps text-outline block mb-1">{name}</span>
      <div className="font-mono text-lg font-bold text-primary">
        {result.unitPrice != null ? `${result.currency || 'USD'} ${Number(result.unitPrice).toFixed(4)}` : 'N/A'}
      </div>
      <div className="text-[11px] text-on-surface-variant mt-1">
        {result.stock != null ? `${result.stock.toLocaleString()} in stock` : 'Stock unknown'}
      </div>
      {result.distributor && (
        <div className="text-[10px] text-secondary mt-1">via {result.distributor}</div>
      )}
      {result.manufacturer && (
        <div className="text-[10px] text-outline mt-1">{result.manufacturer}</div>
      )}
      {result.productUrl && (
        <a href={result.productUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] text-secondary underline block mt-1">
          View listing
        </a>
      )}
      {result.updatedAt && (
        <div className="text-[9px] text-outline mt-1">Scraped {new Date(result.updatedAt).toLocaleString()}</div>
      )}
    </div>
  );
}

export const PricingView: React.FC<PricingViewProps> = ({
  items,
  handleUpdateBulkPrices,
  triggerToast,
  pricingFilter,
  setPricingFilter,
  setSelectedDetailPartNumber,
  setView
}) => {
  const [activeTab, setActiveTab] = useState<'lookup' | 'wizard' | 'directory' | 'keys'>('lookup');
  // Provider credential management. The backend already exposed GET/POST
  // /api/pricing/keys and a live /test, but nothing in the UI called them —
  // keys could only be set by editing .env by hand.
  const [providers, setProviders] = useState<ProviderKeyConfig[]>([]);
  const [keyDrafts, setKeyDrafts] = useState<Record<string, Record<string, string>>>({});
  const [keyBusy, setKeyBusy] = useState<string | null>(null);
  const [keyTest, setKeyTest] = useState<Record<string, { success: boolean; text: string }>>({});

  const loadProviders = React.useCallback(async () => {
    try {
      const res = await fetch('/api/pricing/keys');
      if (!res.ok) return;
      const data = await res.json();
      setProviders(Array.isArray(data) ? data : (data.providers ?? []));
    } catch {
      /* leave the list empty; the tab shows its own empty state */
    }
  }, []);

  React.useEffect(() => { if (activeTab === 'keys') loadProviders(); }, [activeTab, loadProviders]);

  const saveProviderKeys = async (provider: string) => {
    const credentials = keyDrafts[provider] ?? {};
    const filled = Object.fromEntries(Object.entries(credentials).filter(([, v]) => v && v.trim() !== ''));
    if (!Object.keys(filled).length) {
      triggerToast('Enter at least one value before saving.', 'ERROR');
      return;
    }
    setKeyBusy(`save-${provider}`);
    try {
      const res = await fetch('/api/pricing/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, credentials: filled }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      triggerToast(`${provider} credentials saved${data.configured ? '' : ' (still missing required fields)'}.`, 'SUCCESS');
      setKeyDrafts(prev => ({ ...prev, [provider]: {} }));
      await loadProviders();
    } catch (err: any) {
      triggerToast(err.message, 'ERROR');
    } finally {
      setKeyBusy(null);
    }
  };

  const testProviderKeys = async (provider: string) => {
    setKeyBusy(`test-${provider}`);
    setKeyTest(prev => ({ ...prev, [provider]: { success: false, text: 'Testing…' } }));
    try {
      const res = await fetch('/api/pricing/keys/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      const d = await res.json();
      setKeyTest(prev => ({
        ...prev,
        [provider]: d.success
          ? { success: true, text: `OK — ${d.matchedPart ?? 'match'} @ ${d.currency ?? ''}${d.unitPrice ?? '?'}` }
          : { success: false, text: d.error || 'Test failed' },
      }));
    } catch (err: any) {
      setKeyTest(prev => ({ ...prev, [provider]: { success: false, text: err.message } }));
    } finally {
      setKeyBusy(null);
    }
  };
  const [searchInput, setSearchInput] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<SearchResponse | null>(null);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [stockCodeFilter, setStockCodeFilter] = useState('');
  const [supplierFilter, setSupplierFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [enriching, setEnriching] = useState(false);
  const [enrichmentStatus, setEnrichmentStatus] = useState<{itemsProcessed: number; lastRun: string | null}>({itemsProcessed: 0, lastRun: null});
  const ITEMS_PER_PAGE = 50;

  const triggerEnrichment = async () => {
    setEnriching(true);
    try {
      const res = await fetch('/api/automation/enrich-missing-suppliers', { method: 'POST' });
      const result = await res.json();
      setEnrichmentStatus({
        itemsProcessed: result.itemsProcessed || 0,
        lastRun: new Date().toLocaleString()
      });
      triggerToast(`✓ Enriched ${result.itemsProcessed} items with supplier data`, 'success');
    } catch (err: any) {
      triggerToast(`Error: ${err.message}`, 'error');
    } finally {
      setEnriching(false);
    }
  };

  const loadUsage = async () => {
    try {
      const res = await fetch('/api/pricing/usage');
      if (res.ok) setUsage(await res.json());
    } catch {
      // usage meter is best-effort; ignore transient failures
    }
  };

  useEffect(() => {
    loadUsage();
  }, []);

  const handleSearch = async () => {
    const partNumber = searchInput.trim();
    if (!partNumber) return;
    setSearching(true);
    try {
      const res = await fetch(`/api/pricing/search?partNumber=${encodeURIComponent(partNumber)}`);
      if (!res.ok) throw new Error(`Search failed (${res.status})`);
      const data: SearchResponse = await res.json();
      setSearchResult(data);
      await loadUsage();
    } catch (err: any) {
      triggerToast(err.message || 'Pricing search failed', 'error');
    } finally {
      setSearching(false);
    }
  };

  // Pagination logic with multiple filters
  const filteredItems = items.filter(i => {
    const categoryMatch = pricingFilter === 'ALL' || i.category === pricingFilter;
    const stockCodeMatch = !stockCodeFilter || (i.partNumber || '').toLowerCase().includes(stockCodeFilter.toLowerCase());
    const supplierMatch = !supplierFilter || (i.supplier || '').toLowerCase().includes(supplierFilter.toLowerCase());
    const statusMatch = !statusFilter || i.status === statusFilter;
    return categoryMatch && stockCodeMatch && supplierMatch && statusMatch;
  });
  const totalPages = Math.ceil(filteredItems.length / ITEMS_PER_PAGE);
  const startIdx = (currentPage - 1) * ITEMS_PER_PAGE;
  const endIdx = startIdx + ITEMS_PER_PAGE;
  const pageItems = filteredItems.slice(startIdx, endIdx);

  // Reset to page 1 when filter changes
  React.useEffect(() => {
    setCurrentPage(1);
  }, [pricingFilter, stockCodeFilter, supplierFilter, statusFilter]);

  return (
    <div className="p-container-margin space-y-lg max-w-7xl mx-auto w-full">
      {/* Tab Navigation */}
      <div className="flex gap-xs border-b border-outline-variant">
        <button
          onClick={() => setActiveTab('lookup')}
          className={`px-md py-2 text-sm font-bold flex items-center gap-2 whitespace-nowrap transition ${
            activeTab === 'lookup'
              ? 'text-primary border-b-2 border-primary'
              : 'text-on-surface-variant hover:text-on-surface'
          }`}
        >
          <Search className="w-4 h-4" />
          Live Price Lookup
        </button>
        <button
          onClick={() => setActiveTab('wizard')}
          className={`px-md py-2 text-sm font-bold flex items-center gap-2 whitespace-nowrap transition ${
            activeTab === 'wizard'
              ? 'text-primary border-b-2 border-primary'
              : 'text-on-surface-variant hover:text-on-surface'
          }`}
        >
          <Settings className="w-4 h-4" />
          Bulk Pricing
        </button>
        <button
          onClick={() => setActiveTab('directory')}
          className={`px-md py-2 text-sm font-bold flex items-center gap-2 whitespace-nowrap transition ${
            activeTab === 'directory'
              ? 'text-primary border-b-2 border-primary'
              : 'text-on-surface-variant hover:text-on-surface'
          }`}
        >
          <Database className="w-4 h-4" />
          Price Directory ({items.length})
        </button>
        <button
          onClick={() => setActiveTab('keys')}
          className={`px-md py-2 text-sm font-bold flex items-center gap-2 whitespace-nowrap transition ${
            activeTab === 'keys'
              ? 'text-primary border-b-2 border-primary'
              : 'text-on-surface-variant hover:text-on-surface'
          }`}
        >
          <Settings className="w-4 h-4" />
          API Keys
        </button>
      </div>

      {/* Live price lookup tab */}
      {activeTab === 'lookup' && (
      <div className="bg-surface-container rounded-xl border border-outline-variant p-lg">
        <div className="flex justify-between items-center mb-md">
          <span className="font-bold text-sm">Live Price Lookup</span>
        </div>
        <div className="flex gap-sm">
          <input
            type="text"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            placeholder="Enter a part number or manufacturer part number"
            className="flex-1 bg-surface-container-high border border-outline-variant rounded-lg px-3 py-2 text-xs"
          />
          <button
            onClick={handleSearch}
            disabled={searching || !searchInput.trim()}
            className="px-4 py-2 rounded-lg bg-primary text-on-primary text-xs font-bold disabled:opacity-50"
          >
            {searching ? 'Searching…' : 'Search'}
          </button>
        </div>

        {searchResult && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-sm mt-md">
            <ProviderResultCard name="DigiKey" result={searchResult.digikey} />
            <ProviderResultCard name="Mouser" result={searchResult.mouser} />
            <ProviderResultCard name="LCSC (live + cache)" result={searchResult.lcsc} />
            <ProviderResultCard name="Nexar / Octopart" result={searchResult.nexar} />
            <ProviderResultCard name="Element14 / Farnell" result={searchResult.element14} />
            <ProviderResultCard name="TME" result={searchResult.tme} />
          </div>
        )}

        {usage && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-md mt-lg pt-md border-t border-outline-variant">
            <UsageMeter label="DigiKey API calls today" used={usage.digikey.used} limit={usage.digikey.limit} />
            <UsageMeter label="Mouser API calls today" used={usage.mouser.used} limit={usage.mouser.limit} />
            <div>
              <div className="flex justify-between items-center text-[11px] mb-1">
                <span className="text-on-surface-variant">LCSC cached parts</span>
                <span className="font-mono font-bold text-primary">{usage.lcsc.cached}</span>
              </div>
              <span className="text-[10px] text-outline block">
                {usage.lcsc.liveLookup ? 'Live lookup enabled — ' : ''}
                {usage.lcsc.lastUpdated
                  ? `Last sync ${new Date(usage.lcsc.lastUpdated).toLocaleString()}`
                  : 'No data yet — live lookup will populate'}
              </span>
            </div>
            <UsageMeter label="Nexar API calls today" used={usage.nexar.used} limit={usage.nexar.limit} />
            <UsageMeter label="Element14 API calls today" used={usage.element14.used} limit={usage.element14.limit} />
            <UsageMeter label="TME API calls today" used={usage.tme.used} limit={usage.tme.limit} />
          </div>
        )}
        {!usage?.digikey.configured && (
          <div className="text-[10px] text-outline mt-sm">DigiKey API key not configured — add DIGIKEY_CLIENT_ID/SECRET to .env.</div>
        )}
        {usage?.digikey.configured && !usage.digikey.authorized && (
          <div className="text-[10px] text-outline mt-sm">DigiKey not authorized yet — run "npm run digikey:authorize" once.</div>
        )}
        {!usage?.mouser.configured && (
          <div className="text-[10px] text-outline mt-sm">Mouser API key not configured — add MOUSER_API_KEY to .env.</div>
        )}
        {!usage?.nexar?.configured && (
          <div className="text-[10px] text-outline mt-sm">Nexar (Octopart aggregator) not configured — add NEXAR_API_KEY/SECRET to .env for Arrow, Heilind, Avnet coverage.</div>
        )}
        {!usage?.element14?.configured && (
          <div className="text-[10px] text-outline mt-sm">Element14/Farnell API not configured — add ELEMENT14_API_KEY to .env.</div>
        )}
        {!usage?.tme?.configured && (
          <div className="text-[10px] text-outline mt-sm">TME API not configured — add TME_API_KEY/SECRET to .env.</div>
        )}
      </div>
      )}

      {/* Bulk Pricing Wizard tab */}
      {activeTab === 'wizard' && (
      <div>
      <BulkPricingWizard
        items={items}
        onUpdatePrices={handleUpdateBulkPrices}
        onShowNotification={triggerToast}
      />
      </div>
      )}

      {/* Price Directory tab */}
      {activeTab === 'directory' && (
      <div className="bg-surface-container rounded-xl border border-outline-variant overflow-hidden">
        <div className="px-lg py-sm border-b border-outline-variant bg-surface-container-high/10 flex justify-between items-center">
          <div className="flex items-center gap-md">
            <span className="font-bold text-sm">Inventory Price List</span>
            <span className="text-xs text-on-surface-variant">({filteredItems.length} items)</span>

            {/* Enrichment Status */}
            {enrichmentStatus.lastRun && (
              <div className="flex items-center gap-1 bg-green-500/10 border border-green-500/20 rounded px-2 py-1">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400"></span>
                <span className="text-[10px] font-mono text-green-400">
                  {enrichmentStatus.itemsProcessed} enriched • {enrichmentStatus.lastRun}
                </span>
              </div>
            )}
          </div>
          <div className="flex gap-sm select-none text-xs items-center">
            <button
              onClick={triggerEnrichment}
              disabled={enriching}
              className={`px-3 py-1.5 rounded font-bold transition flex items-center gap-2 ${
                enriching
                  ? 'bg-primary/50 text-on-primary cursor-wait'
                  : 'bg-primary text-on-primary hover:brightness-110'
              }`}
            >
              {enriching ? (
                <>
                  <div className="w-3 h-3 border-2 border-on-primary/30 border-t-on-primary rounded-full animate-spin"></div>
                  Enriching...
                </>
              ) : (
                '🔍 Enrich N/A Suppliers'
              )}
            </button>
          </div>
          <div className="flex gap-sm select-none text-xs">
            <button
              onClick={() => setPricingFilter('ALL')}
              className={`px-2.5 py-1 rounded border ${pricingFilter === 'ALL' ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-high text-on-surface-variant'}`}
            >
              All Classes
            </button>
            <button
              onClick={() => setPricingFilter('Micro-ctrl')}
              className={`px-2.5 py-1 rounded border ${pricingFilter === 'Micro-ctrl' ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-high text-on-surface-variant'}`}
            >
              Microcontrollers
            </button>
            <button
              onClick={() => setPricingFilter('Capacitors')}
              className={`px-2.5 py-1 rounded border ${pricingFilter === 'Capacitors' ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-high text-on-surface-variant'}`}
            >
              Capacitors
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-surface-container-high/50 border-b border-outline-variant">
                <th className="px-lg py-sm">
                  <div className="flex flex-col gap-1">
                    <span className="font-label-caps text-[10px] text-outline">Stock Code</span>
                    <input
                      type="text"
                      placeholder="Filter..."
                      value={stockCodeFilter}
                      onChange={(e) => setStockCodeFilter(e.target.value)}
                      className="bg-surface-container-high border border-outline-variant rounded px-2 py-1 text-xs text-on-surface placeholder-on-surface-variant/50 w-full"
                    />
                  </div>
                </th>
                <th className="px-lg py-sm">
                  <div className="flex flex-col gap-1">
                    <span className="font-label-caps text-[10px] text-outline">Supplier</span>
                    <input
                      type="text"
                      placeholder="Filter..."
                      value={supplierFilter}
                      onChange={(e) => setSupplierFilter(e.target.value)}
                      className="bg-surface-container-high border border-outline-variant rounded px-2 py-1 text-xs text-on-surface placeholder-on-surface-variant/50 w-full"
                    />
                  </div>
                </th>
                <th className="px-lg py-sm text-right">
                  <span className="font-label-caps text-[10px] text-outline block">Base unit price</span>
                </th>
                <th className="px-lg py-sm">
                  <div className="flex flex-col gap-1">
                    <span className="font-label-caps text-[10px] text-outline">Status</span>
                    <select
                      value={statusFilter}
                      onChange={(e) => setStatusFilter(e.target.value)}
                      className="bg-surface-container-high border border-outline-variant rounded px-2 py-1 text-xs text-on-surface w-full"
                    >
                      <option value="">All</option>
                      <option value="ACTIVE">ACTIVE</option>
                      <option value="INACTIVE">INACTIVE</option>
                      <option value="BOOKED OUT">BOOKED OUT</option>
                    </select>
                  </div>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30 text-xs">
              {pageItems.map(i => (
                  <tr key={i.partNumber} className="hover:bg-surface-variant/20 transition-all duration-150">
                    <td className="px-lg py-sm font-mono font-bold text-primary">
                      {i.partNumber}
                      <span className="text-[10px] text-on-surface block font-normal font-sans">{i.name}</span>
                    </td>
                    <td className="px-lg py-sm">
                      <span className="bg-surface-container-high border border-outline-variant px-sm py-0.5 rounded text-xs select-none">
                        {i.supplier}
                      </span>
                    </td>
                    <td className="px-lg py-sm font-mono text-right text-primary font-bold text-sm">
                      ${(Number(i.price ?? 0)).toFixed(3)}
                    </td>
                    <td className="px-lg py-sm">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[9px] font-bold border ${i.status === 'ACTIVE' ? 'bg-green-500/10 text-green-400 border-green-500/20' :
                        i.status === 'INACTIVE' ? 'bg-red-500/10 text-red-500 border-red-500/20' :
                          i.status === 'BOOKED OUT' ? 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20' :
                            'bg-surface-container-highest text-outline border-outline-variant'
                        }`}>{i.status}</span>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        {/* Pagination Controls */}
        {totalPages > 1 && (
          <div className="px-lg py-sm border-t border-outline-variant bg-surface-container-high/10 flex justify-between items-center">
            <span className="text-xs text-on-surface-variant">
              Page {currentPage} of {totalPages} ({startIdx + 1}–{Math.min(endIdx, filteredItems.length)} of {filteredItems.length})
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="p-2 rounded-lg bg-surface-container-high text-on-surface-variant hover:text-on-surface disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="p-2 rounded-lg bg-surface-container-high text-on-surface-variant hover:text-on-surface disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
      )}

      {/* API key management. Values are write-only from here: the server returns
          a masked preview and never the stored secret. */}
      {activeTab === 'keys' && (
        <div className="space-y-md">
          <div className="bg-surface-container rounded-xl border border-outline-variant p-lg">
            <h3 className="text-sm font-bold text-on-surface mb-1">Supplier API Credentials</h3>
            <p className="text-xs text-on-surface-variant">
              Saved keys are stored in the database and take effect immediately — no restart, no
              editing <span className="font-mono">.env</span>. A value already set in{' '}
              <span className="font-mono">.env</span> is used as a fallback and shown as such.
              Existing secrets are never sent back to the browser, so fields show a masked preview
              and stay blank until you enter a replacement.
            </p>
          </div>

          {providers.length === 0 ? (
            <div className="bg-surface-container rounded-xl border border-outline-variant p-lg text-center text-xs text-outline italic">
              Loading providers…
            </div>
          ) : providers.map(p => {
            const test = keyTest[p.provider];
            return (
              <div key={p.provider} className="bg-surface-container rounded-xl border border-outline-variant p-lg space-y-md">
                <div className="flex items-start justify-between gap-md flex-wrap">
                  <div className="min-w-[240px]">
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-bold text-on-surface">{p.label}</h4>
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
                        p.configured
                          ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                          : 'bg-orange-500/10 text-orange-400 border border-orange-500/20'
                      }`}>
                        {p.configured ? 'Configured' : 'Not configured'}
                      </span>
                    </div>
                    <p className="text-[11px] text-on-surface-variant mt-1">{p.description}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => testProviderKeys(p.provider)}
                      disabled={!!keyBusy || !p.configured}
                      title={p.configured ? 'Run a live lookup with these credentials' : 'Set the required fields first'}
                      className="px-md py-1.5 rounded-lg border border-outline-variant text-xs font-bold text-on-surface hover:bg-surface-container-high disabled:opacity-40"
                    >
                      {keyBusy === `test-${p.provider}` ? 'Testing…' : 'Test'}
                    </button>
                    <button
                      onClick={() => saveProviderKeys(p.provider)}
                      disabled={!!keyBusy}
                      className="px-md py-1.5 rounded-lg bg-primary text-on-primary text-xs font-bold hover:brightness-110 disabled:opacity-40"
                    >
                      {keyBusy === `save-${p.provider}` ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>

                {test && (
                  <div className={`text-[11px] rounded-lg px-3 py-2 border ${
                    test.success
                      ? 'bg-green-500/10 text-green-400 border-green-500/20'
                      : 'bg-red-500/10 text-red-400 border-red-500/20'
                  }`}>
                    {test.text}
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {p.fields.map(f => (
                    <div key={f.name} className="flex flex-col gap-1">
                      <label className="text-[10px] font-bold text-outline uppercase tracking-wide flex items-center gap-1.5">
                        {f.label}
                        {f.required && <span className="text-error">*</span>}
                        {f.hasValue && (
                          <span className="font-normal normal-case text-[9px] text-on-surface-variant/70">
                            set{f.source ? ` via ${f.source === 'env' ? '.env' : 'database'}` : ''}
                            {f.masked ? ` · ${f.masked}` : ''}
                          </span>
                        )}
                      </label>
                      <input
                        type={f.type === 'password' ? 'password' : 'text'}
                        autoComplete="off"
                        placeholder={f.hasValue ? 'Enter a new value to replace' : `Not set — ${f.envVar}`}
                        value={keyDrafts[p.provider]?.[f.name] ?? ''}
                        onChange={(e) => setKeyDrafts(prev => ({
                          ...prev,
                          [p.provider]: { ...(prev[p.provider] ?? {}), [f.name]: e.target.value },
                        }))}
                        className="bg-surface-container-high border border-outline-variant rounded px-3 py-2 text-xs font-mono text-on-surface outline-none focus:border-primary"
                      />
                      {f.help && <span className="text-[9px] text-on-surface-variant/60">{f.help}</span>}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};