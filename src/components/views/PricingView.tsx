import React, { useEffect, useState } from 'react';
import { Item, ViewType } from '../../types';
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
}

interface SearchResponse {
  partNumber: string;
  digikey?: ProviderResult;
  mouser?: ProviderResult;
  lcsc?: ProviderResult;
}

interface UsageResponse {
  digikey: { used: number; limit: number; configured: boolean; authorized: boolean };
  mouser: { used: number; limit: number; configured: boolean };
  lcsc: { cached: number; lastUpdated: string | null };
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
  const [searchInput, setSearchInput] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<SearchResponse | null>(null);
  const [usage, setUsage] = useState<UsageResponse | null>(null);

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

  return (
    <div className="p-container-margin space-y-4 max-w-7xl mx-auto w-full">
      {/* Live price lookup */}
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
          <div className="grid grid-cols-1 md:grid-cols-3 gap-sm mt-md">
            <ProviderResultCard name="DigiKey" result={searchResult.digikey} />
            <ProviderResultCard name="Mouser" result={searchResult.mouser} />
            <ProviderResultCard name="LCSC (scraped)" result={searchResult.lcsc} />
          </div>
        )}

        {usage && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-md mt-lg pt-md border-t border-outline-variant">
            <UsageMeter label="DigiKey API calls today" used={usage.digikey.used} limit={usage.digikey.limit} />
            <UsageMeter label="Mouser API calls today" used={usage.mouser.used} limit={usage.mouser.limit} />
            <div>
              <div className="flex justify-between items-center text-[11px] mb-1">
                <span className="text-on-surface-variant">LCSC cached parts</span>
                <span className="font-mono font-bold text-primary">{usage.lcsc.cached}</span>
              </div>
              <span className="text-[10px] text-outline block">
                {usage.lcsc.lastUpdated
                  ? `Last scrape sync ${new Date(usage.lcsc.lastUpdated).toLocaleString()}`
                  : 'No scrape data imported yet'}
              </span>
            </div>
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
      </div>

      {/* Wholesale Volume Calibration Wizard */}
      <BulkPricingWizard
        items={items}
        onUpdatePrices={handleUpdateBulkPrices}
        onShowNotification={triggerToast}
      />

      {/* Main list of items with price list */}
      <div className="bg-surface-container rounded-xl border border-outline-variant overflow-hidden">
        <div className="px-lg py-sm border-b border-outline-variant bg-surface-container-high/10 flex justify-between items-center">
          <span className="font-bold text-sm">Inventory Price List</span>
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
              <tr className="bg-surface-container-high/50 font-label-caps text-[10px] text-outline border-b border-outline-variant">
                <th className="px-lg py-sm">Product specification</th>
                <th className="px-lg py-sm">Preferred Supplier</th>
                <th className="px-lg py-sm text-right">Base unit price</th>
                <th className="px-lg py-sm">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30 text-xs">
              {items
                .filter(i => pricingFilter === 'ALL' || i.category === pricingFilter)
                .map(i => (
                  <tr key={i.partNumber} className="hover:bg-surface-variant/20 transition-all duration-150">
                    <td className="px-lg py-sm font-bold text-on-surface">
                      {i.name}
                      <span className="text-[10px] text-outline block font-normal font-mono">{i.partNumber} &bull; {i.category}</span>
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
      </div>
    </div>
  );
};
