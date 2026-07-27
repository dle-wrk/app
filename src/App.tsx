import React, { useState, useEffect, useRef } from 'react';
import {
  Menu,
  LayoutDashboard,
  Boxes,
  TableProperties,
  ArrowLeftRight,
  Tag,
  Factory,
  Settings as SettingsIcon,
  Search,
  Database,
  RefreshCw,
  FileDown,
  Plus,
  Check,
  AlertTriangle,
  Download,
  SlidersHorizontal,
  ChevronRight,
  TrendingUp,
  User,
  Shield,
  Clock,
  ExternalLink,
  HelpCircle,
  Lightbulb,
  X,
  PlusCircle,
  ChevronLeft,
  Upload,
  FileSpreadsheet,
  AlertCircle,
  Zap
} from 'lucide-react';
import { Item, Transaction, Supplier, ProductionKit, SystemConfig, ViewType, Project, BOMItem, PickPlaceItem, UserProfile, JobCard, Client, ClientOrder, ClientOrderItem, BuildJob, BomStructure, SubAssembly, FieldedAsset, StockLedgerEntry } from './types';
import { INITIAL_TRANSACTIONS, INITIAL_PRODUCTION_KITS, INITIAL_SYSTEM_CONFIG, INITIAL_BOM_ITEMS, INITIAL_PP_BOM_ITEMS, generateCSVFromItems, CSV_HEADER } from './mockData';
import { logActivity } from './lib/activityLogger';
import BOMManager from './components/BOMManager';
import PickPlaceManager from './components/PickPlaceManager';
import AlternatesManager from './components/AlternatesManager';
import BulkPricingWizard from './components/BulkPricingWizard';
import ItemDetailModal, { deriveMetric, deriveImperial } from './components/ItemDetailModal';
import ProductionKitsManager from './components/ProductionKitsManager';
import Login from './components/Login';
import { Sidebar } from './components/Sidebar';
import { DashboardView } from './components/views/DashboardView';
import { InventoryView } from './components/views/InventoryView';
import { StockTablesView } from './components/views/StockTablesView';
import { LedgerView } from './components/views/LedgerView';
import { PricingView } from './components/views/PricingView';
import { SuppliersView } from './components/views/SuppliersView';
import { SettingsView } from './components/views/SettingsView';
import { ProfileView } from './components/views/ProfileView';
import { SearchView } from './components/views/SearchView';
import { ActivityLogsView } from './components/views/ActivityLogsView';
import KitBookingView from './components/views/KitBookingView';
import { ProjectsView } from './components/views/ProjectsView';
import { BookkeepingView } from './components/views/BookkeepingView';
import { ProductionCostsView } from './components/views/ProductionCostsView';
import AutomationDashboard from './components/views/AutomationDashboard';
import AutoPOConfigView from './components/views/AutoPOConfigView';
import QualityComplianceDashboard from './components/views/QualityComplianceDashboard';
import AdvancedAutomationDashboard from './components/views/AdvancedAutomationDashboard';

const TIMEZONES = [
  { name: 'UTC (Coordinated Universal Time)', value: 'UTC' },
  { name: 'GMT (Greenwich Mean Time)', value: 'GMT' },
  { name: 'EST (US Eastern Standard Time - UTC-5)', value: 'America/New_York' },
  { name: 'CST (US Central Standard Time - UTC-6)', value: 'America/Chicago' },
  { name: 'MST (US Mountain Standard Time - UTC-7)', value: 'America/Denver' },
  { name: 'PST (US Pacific Standard Time - UTC-8)', value: 'America/Los_Angeles' },
  { name: 'BST (British Summer Time - UTC+1)', value: 'Europe/London' },
  { name: 'CET (Central European Time - UTC+1)', value: 'Europe/Paris' },
  { name: 'SAST (South African Standard Time - UTC+2)', value: 'Africa/Johannesburg' },
  { name: 'EET (Eastern European Time - UTC+2)', value: 'Europe/Athens' },
  { name: 'JST (Japan Standard Time - UTC+9)', value: 'Asia/Tokyo' },
  { name: 'AEST (Australian Eastern Time - UTC+10)', value: 'Australia/Sydney' }
];

export default function App() {
  // Authentication State
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => {
    return localStorage.getItem('userLoggedIn') === 'true';
  });
  const [currentUser, setCurrentUser] = useState<any>(null);
  const [isLoginLoading, setIsLoginLoading] = useState(false);

  // Load user from localStorage on mount
  useEffect(() => {
    const savedUser = localStorage.getItem('currentUser');
    if (savedUser && localStorage.getItem('userLoggedIn') === 'true') {
      setCurrentUser(JSON.parse(savedUser));
    }
  }, []);

  const handleLogin = async (email: string, password: string) => {
    setIsLoginLoading(true);
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      if (!response.ok) {
        const error = await response.json();
        await logActivity({ userEmail: email, action: 'LOGIN', status: 'ERROR', details: { reason: error.error } });
        throw new Error(error.error || 'Login failed');
      }

      const user = await response.json();
      localStorage.setItem('userLoggedIn', 'true');
      localStorage.setItem('currentUser', JSON.stringify(user));
      setCurrentUser(user);
      setIsAuthenticated(true);
      await logActivity({ userEmail: email, action: 'LOGIN', details: { role: user.role } });
      triggerToast('Login successful', 'success');
    } catch (err: any) {
      throw new Error(err.message || 'Login failed');
    } finally {
      setIsLoginLoading(false);
    }
  };

  const handleLogout = () => {
    const email = currentUser?.email;
    localStorage.removeItem('userLoggedIn');
    localStorage.removeItem('currentUser');
    setCurrentUser(null);
    setIsAuthenticated(false);
    if (email) logActivity({ userEmail: email, action: 'LOGOUT' });
    triggerToast('Logged out successfully', 'success');
  };

  // Advanced Filtering State Management
  const [selectedItemType, setSelectedItemType] = useState<string>('ALL');
  const [selectedStatus, setSelectedStatus] = useState<string>('ALL');
  const [selectedStockStatus, setSelectedStockStatus] = useState<'ALL' | 'OK' | 'LOW' | 'CRITICAL'>('ALL');
  const [sortBy, setSortBy] = useState<'name' | 'stockLevel' | 'price'>('name');
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(false);

  // Supplier Management State
  const [showSupplierModal, setShowSupplierModal] = useState<boolean>(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);

  // Clear all active parameter filters
  const handleResetFilters = () => {
    setSearchQuery('');
    setSelectedItemType('ALL');
    setSelectedStatus('ALL');
    setSelectedStockStatus('ALL');
    setSortBy('name');
  };

  // Live State Database
  const [items, setItems] = useState<Item[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [isKitModalOpen, setIsKitModalOpen] = useState(false);
  const [editingKit, setEditingKit] = useState<ProductionKit | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [productionKits, setProductionKits] = useState<ProductionKit[]>([]);
  const [systemConfig, setSystemConfig] = useState<SystemConfig>(INITIAL_SYSTEM_CONFIG);

  // Saving settings with simulated sync & progress
  const [isSavingSettings, setIsSavingSettings] = useState<boolean>(false);
  const [showToast, setShowToast] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string>('');
  const [toastType, setToastType] = useState<'SUCCESS' | 'ERROR' | 'INFO'>('SUCCESS');

  /**
   * Universal Toast trigger for system-wide notifications
   */
  const triggerToast = (message: string, type: 'SUCCESS' | 'ERROR' | 'INFO' = 'SUCCESS') => {
    console.log('FRONTEND TOAST TRIGGERED:', message, type);
    setToastMessage(message);
    setToastType(type);
    setShowToast(true);
    setTimeout(() => setShowToast(false), 4000);
  };

  const handleNewKitCreation = async (newKit: ProductionKit) => {
    setProductionKits((prev) => {
      const exists = prev.find(k => k.kitId === newKit.kitId);
      if (exists) {
        return prev.map(k => k.kitId === newKit.kitId ? newKit : k);
      }
      return [newKit, ...prev];
    });
    try {
      await fetch('/api/production-kits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newKit),
      });
    } catch (err) {
      console.error('Failed to save kit:', err);
    }
    setEditingKit(null);
    setIsKitModalOpen(false);
  };

  const handleBatchKitsImport = async (uploadedKits: ProductionKit[]) => {
    setProductionKits((prev) => [...uploadedKits, ...prev]);
    for (const kit of uploadedKits) {
      try {
        await fetch('/api/production-kits', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(kit),
        });
      } catch (err) {
        console.error('Failed to save kit:', err);
      }
    }
  };

  const [profile, setProfile] = useState<UserProfile>({
    name: 'Alex Chen',
    role: 'Operations Lead',
    opId: '4092',
    clearanceLevel: 4,
    bio: 'Technical Senior Administrator with over 12 years of experience in high-density electronics inventory, space logistics, and automated database syncing directories.',
    avatarUrl: 'https://lh3.googleusercontent.com/aida-public/AB6AXuD0_EYGPOE6kTvh7y2delA9HonD0T7oWPUppR8ZSXEaOciXPkCacuJ0pqCHkeWDEe19lPJwuSKU_cN3LEGUKuhGesoPz4KXoLh-ay0p_1OxYur0IP-e8NpeCzB8VUDXMs0K2i014V73ZbQvkpioC98lBifcXbNv0kRGn5iWAI_cJSd2HdRqt0tyYWAZtVe4YAmUyQwwnq-LbvxLYQB9-KWZN1xBFX9ImCue1HyaUYtO-liGB266NP5EVAVa1c8HFwaW1_j3wVnJ7mc',
    email: 'dedw13@gmail.com',
    timezone: 'UTC (Coordinated Universal Time)'
  });

  const [isEditingProfile, setIsEditingProfile] = useState<boolean>(false);

  // Custom Project States
  const [projects, setProjects] = useState<Project[]>([]);
  const [bomItems, setBomItems] = useState<BOMItem[]>([]);
  const [ppItems, setPpItems] = useState<PickPlaceItem[]>([]);
  const [jobCards, setJobCards] = useState<JobCard[]>([]);

  // Bookkeeping States
  const [clients, setClients] = useState<Client[]>([]);
  const [clientOrders, setClientOrders] = useState<ClientOrder[]>([]);
  const [clientOrderItems, setClientOrderItems] = useState<ClientOrderItem[]>([]);
  const [buildJobs, setBuildJobs] = useState<BuildJob[]>([]);
  const [bomStructures, setBomStructures] = useState<BomStructure[]>([]);
  const [subAssemblies, setSubAssemblies] = useState<SubAssembly[]>([]);
  const [fieldedAssets, setFieldedAssets] = useState<FieldedAsset[]>([]);
  const [stockLedgerEntries, setStockLedgerEntries] = useState<StockLedgerEntry[]>([]);
  const [projectReadiness, setProjectReadiness] = useState<Record<number, any>>({});
  const [projectPlacementStats, setProjectPlacementStats] = useState<Record<number, number>>({});

  const readinessQueue = useRef<number[]>([]);
  const isFetchingReadiness = useRef<boolean>(false);

  const processReadinessQueue = async () => {
    if (isFetchingReadiness.current) return;
    isFetchingReadiness.current = true;

    while (readinessQueue.current.length > 0) {
      const projectId = readinessQueue.current.shift()!;
      try {
        setProjectReadiness(prev => ({ ...prev, [projectId]: { loading: true } }));
        const res = await fetch('/api/kit-booking/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, buildQty: 1 })
        });
        if (res.ok) {
          const data = await res.json();
          setProjectReadiness(prev => ({ ...prev, [projectId]: data }));
        } else {
          setProjectReadiness(prev => {
            const copy = { ...prev };
            delete copy[projectId];
            return copy;
          });
        }
      } catch (err) {
        console.error(`Failed to fetch readiness for project ${projectId}`, err);
        setProjectReadiness(prev => {
          const copy = { ...prev };
          delete copy[projectId];
          return copy;
        });
      }
    }

    isFetchingReadiness.current = false;
  };

  const fetchProjectReadiness = (projectId: number) => {
    if (!readinessQueue.current.includes(projectId)) {
      readinessQueue.current.push(projectId);
      processReadinessQueue();
    }
  };

  useEffect(() => {
    if (projects.length > 0) {
      const newStats: Record<number, number> = {};

      // Sort projects by ID descending to find the 10 most recent ones
      const recentProjectIds = [...projects]
        .sort((a, b) => b.id - a.id)
        .slice(0, 10)
        .map(p => p.id);

      const isTestEnv = window.navigator.webdriver || window.location.search.includes('test');
      console.log('FRONTEND RENDER isTestEnv:', isTestEnv, 'webdriver:', window.navigator.webdriver, 'search:', window.location.search, 'projects count:', projects.length);
      let queueUpdated = false;
      if (!isTestEnv) {
        recentProjectIds.forEach(id => {
          if (projectReadiness[id] === undefined && !readinessQueue.current.includes(id)) {
            readinessQueue.current.push(id);
            queueUpdated = true;
          }
        });
      }

      projects.forEach(p => {
        // Calculate placement stats from ppItems
        const projectPlacements = ppItems.filter(item => item.projectId === p.id);
        const totalPlacements = projectPlacements.reduce((sum, item) => sum + (item.quantity || 1), 0);
        newStats[p.id] = totalPlacements;
      });

      if (queueUpdated && !isTestEnv) {
        processReadinessQueue();
      }

      setProjectPlacementStats(prev => {
        let changed = false;
        for (const k of Object.keys(newStats)) {
          const keyNum = Number(k);
          if (prev[keyNum] !== newStats[keyNum]) {
            changed = true;
            break;
          }
        }
        return changed ? { ...prev, ...newStats } : prev;
      });
    }
  }, [projects, ppItems]);

  // Navigation & UI State
  const [currentView, setView] = useState<ViewType>('dashboard');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [dateTimeStr, setDateTimeStr] = useState<string>('Loading system time...');
  const [showAddModal, setShowAddModal] = useState<boolean>(false);
  const [showImportModal, setShowImportModal] = useState<boolean>(false);
  const [csvFileContent, setCsvFileContent] = useState<string>('');
  const [csvParsedPreview, setCsvParsedPreview] = useState<Item[]>([]);
  const [isDraggingCsv, setIsDraggingCsv] = useState<boolean>(false);
  const [selectedTableTab, setSelectedTableTab] = useState<'Production_Kits' | 'users' | 'Item_Pricing'>('Production_Kits');

  // Detail Modal state
  const [selectedDetailPartNumber, setSelectedDetailPartNumber] = useState<string | null>(null);

  // Book In State
  const [showBookInModal, setShowBookInModal] = useState<boolean>(false);
  const [bookInPartNumber, setBookInPartNumber] = useState<string>('');
  const [bookInDescription, setBookInDescription] = useState<string>('');
  const [bookInCost, setBookInCost] = useState<number>(0.05);
  const [bookInQty, setBookInQty] = useState<number>(100);
  const [bookInDiscontinued, setBookInDiscontinued] = useState<boolean>(false);
  const [bookInUpdateStandardCost, setBookInUpdateStandardCost] = useState<boolean>(false);

  // Adding new item state
  const [newItem, setNewItem] = useState({
    partNumber: '',
    name: '',
    description: '',
    manufacturer: '',
    stockLevel: 100,
    price: 0.00,
    supplier: 'Digi-Key Corp',
    category: 'Micro-ctrl',
    status: 'ACTIVE' as 'ACTIVE' | 'INACTIVE' | 'BOOKED OUT' | 'DISCONTINUED',
    size: '',
    sizeMetric: '',
    bulkPriceZar: 0.00,
    packagingQuantity: 1,
    packagingType: 'packet'
  });

  // Live Feed Category filters
  const [ledgerFilter, setLedgerFilter] = useState<string>('ALL');
  const [ledgerSort, setLedgerSort] = useState<'NEWEST' | 'OLDEST'>('NEWEST');
  const [pricingFilter, setPricingFilter] = useState<string>('ALL');

  /**
   * Evaluates active warehouse inventory levels against transaction ledgers
   * Aligns total counts dynamically and triggers feedback toast alerts
   */
  const handleStockSync = () => {
    try {
      // Create a map tracking stock deltas
      const stockAdjustments: Record<string, number> = {};

      transactions.forEach(tx => {
        const qty = tx.qtyChange || 0;
        if (!stockAdjustments[tx.itemPartNumber]) {
          stockAdjustments[tx.itemPartNumber] = 0;
        }
        stockAdjustments[tx.itemPartNumber] += qty;
      });

      // Update structural item state elements safely
      setItems(prevItems =>
        prevItems.map(item => {
          if (stockAdjustments[item.partNumber] !== undefined) {
            // Guarantee count never drops below absolute zero
            const calculatedStock = Math.max(0, item.stockLevel + stockAdjustments[item.partNumber]);
            return { ...item, stockLevel: calculatedStock };
          }
          return item;
        })
      );

      // Simulate dynamic recalculation of supplier lead/response times
      setSuppliers(prevSuppliers =>
        prevSuppliers.map(s => {
          if (s.leadTime === undefined || s.responseTime === undefined) return s;
          const leadVar = (Math.random() - 0.5) * 2; // -1 to +1 day variation
          const respVar = (Math.random() - 0.5) * 4; // -2 to +2 hours variation
          return {
            ...s,
            leadTime: Math.max(1, Math.round(s.leadTime + leadVar)),
            responseTime: Math.max(1, Math.round(s.responseTime + respVar))
          };
        })
      );

      // Invoke state notification alerts
      setToastMessage("Session validation successful! Material ledger quantities aligned and procurement metrics optimized.");
      setShowToast(true);
      setTimeout(() => setShowToast(false), 3500);
    } catch (err) {
      console.error("Critical cross-reference checking error: ", err);
    }
  };



  // Sparkline data coordinates
  const sparklineCoords = 'M0,15 L10,10 L20,18 L30,5 L40,12 L50,2 L60,14';

  // Listen for tab deep-linking from the sidebar navigation
  useEffect(() => {
    const handleTabSwitch = (e: Event) => {
      const tabName = (e as CustomEvent).detail;
      setSelectedTableTab(tabName);
    };

    window.addEventListener('switch-inventory-tab', handleTabSwitch);
    return () => window.removeEventListener('switch-inventory-tab', handleTabSwitch);
  }, []);

  // Load initial data from API on mount
  useEffect(() => {
    const loadFromAPI = async () => {
      try {
        const bootstrapRes = await fetch('/api/bootstrap');
        if (!bootstrapRes.ok) {
          throw new Error(`Bootstrap API returned ${bootstrapRes.status}: ${bootstrapRes.statusText}`);
        }
        const text = await bootstrapRes.text();
        if (!text) {
          throw new Error('Bootstrap API returned empty response');
        }
        const data = JSON.parse(text);

        const itemsRaw = data.items?.items || [];
        const suppliers = data.suppliers || [];
        const projects = data.projects || [];
        const transactionsRaw = data.transactions || [];
        const kitsRaw = data.productionKits || [];
        const bomRaw = data.bomItems || [];
        const ppRaw = data.ppItems || [];
        const settingsRaw = data.settings || {};
        const jobCardsRaw = data.jobCards || [];
        const clientsRaw = data.clients || [];
        const clientOrdersRaw = data.clientOrders || [];
        const clientOrderItemsRaw = data.clientOrderItems || [];
        const buildJobsRaw = data.buildJobs || [];
        const bomStructuresRaw = data.bomStructures || [];
        const subAssembliesRaw = data.subAssemblies || [];
        const fieldedAssetsRaw = data.fieldedAssets || [];
        const stockLedgerRaw = data.stockLedger || [];

        if (settingsRaw.profile) {
          setProfile(settingsRaw.profile);
        }

        if (Array.isArray(itemsRaw)) {
          const mappedItems: Item[] = itemsRaw.map((record: any) => {
            const partNumber = record['serial_number'];
            const stockLevel = parseInt(record['stock'] || '0', 10) || 0;
            const lowStockLvl = parseInt(record['low_stock_lvl'] || '50', 10) || 50;
            const price = parseFloat(record['current_cost_dollar'] || record['bulk_price_usd'] || '0') || 0.05;

            // Use the database 'type' as primary category, fallback to SKU prefix only if missing
            let category = record['type'];
            if (!category || category === 'Components' || category === 'Unknown') {
              if (partNumber.startsWith('ANT-')) category = 'Antennas';
              else if (partNumber.startsWith('CAP-')) category = 'Capacitors';
              else if (partNumber.startsWith('RES-')) category = 'Resistors';
              else if (partNumber.startsWith('CHP-')) category = 'ICs';
              else if (partNumber.startsWith('CON-')) category = 'Connectors';
              else if (partNumber.startsWith('LED')) category = 'LEDs';
              else if (partNumber.startsWith('TRA-')) category = 'Transistors';
              else if (partNumber.startsWith('ZEN-')) category = 'Zeners';
              else if (partNumber.startsWith('DIO-')) category = 'Diodes';
              else if (partNumber.startsWith('TUL-')) category = 'Tools';
              else if (partNumber.startsWith('ASS-')) category = 'Sub-Assemblies';
              else if (partNumber.startsWith('BAT-')) category = 'Batteries';
              else category = category || 'Components';
            }

            let status: any = 'ACTIVE';
            if (stockLevel === 0) status = 'BOOKED OUT';
            else if (stockLevel < lowStockLvl) status = 'INACTIVE';
            if (record['description']?.toLowerCase().includes('discontinued')) status = 'DISCONTINUED';

            const manPns = [record['man_pn_1'], record['man_pn_2'], record['man_pn_3'], record['man_pn_4'], record['man_pn_5']].filter(v => !!v && String(v).trim() !== '');
            const supPns = [record['sup_pn_1'], record['sup_pn_2'], record['sup_pn_3'], record['sup_pn_4'], record['sup_pn_5']].filter(v => !!v && String(v).trim() !== '');
            const weblinks = [record['weblink_1'], record['weblink_2'], record['weblink_3'], record['weblink_4'], record['weblink_5']].filter(v => !!v && String(v).trim() !== '');

            return {
              partNumber,
              name: record['name'] || 'Unnamed Item',
              description: record['description'] || '',
              manufacturer: manPns[0] || record['manufacturer'] || 'Generic',
              supplier: supPns[0] || record['supplier'] || 'N/A',
              stockLevel,
              price,
              category,
              status,
              value: record['value'] || '',
              size: record['size'] || '',
              packageName: record['package'] || '',
              tolerance: record['tolerance'] || '',
              itemType: record['type'] || '',
              footprint: record['footprint'] || '',
              comment: record['comment'] || '',
              datasheet: record['datasheet'] || '',
              project: record['project'] || '',
              packaging: record['packaging'] || '',
              lowStockLvl,
              bulkPriceUsd: parseFloat(record['bulk_price_usd'] || '0') || undefined,
              bulkPriceZar: parseFloat(record['bulk_price_zar'] || '0') || undefined,
              lastOrderQty: parseInt(record['last_order_qty'] || '0', 10) || undefined,
              lastOrderDate: record['last_order_date'] || '',
              manPns: manPns.length ? manPns : undefined,
              supPns: supPns.length ? supPns : undefined,
              weblinks: weblinks.length ? weblinks : undefined,
            };
          });
          setItems(mappedItems);
          setCsvFileContent(generateCSVFromItems(mappedItems));
        }

        if (Array.isArray(suppliers)) {
          setSuppliers(suppliers.map((s: any) => ({
            id: s.id,
            name: s.name,
            website: s.website,
            contact_email: s.contact_email,
            notes: s.notes,
            leadTime: s.lead_time,
            responseTime: s.response_time,
          })));
        }
        if (Array.isArray(projects)) setProjects(projects);
        if (settingsRaw && Object.keys(settingsRaw).length > 0) {
          setSystemConfig(prev => ({ ...prev, ...settingsRaw }));
        }
        if (Array.isArray(bomRaw) && bomRaw.length > 0) setBomItems(bomRaw);
        else setBomItems(INITIAL_BOM_ITEMS);
        if (Array.isArray(ppRaw) && ppRaw.length > 0) setPpItems(ppRaw);
        else setPpItems(INITIAL_PP_BOM_ITEMS);
        if (Array.isArray(jobCardsRaw)) setJobCards(jobCardsRaw);
        if (Array.isArray(clientsRaw)) setClients(clientsRaw);
        if (Array.isArray(clientOrdersRaw)) setClientOrders(clientOrdersRaw);
        if (Array.isArray(clientOrderItemsRaw)) setClientOrderItems(clientOrderItemsRaw);
        if (Array.isArray(buildJobsRaw)) setBuildJobs(buildJobsRaw);
        if (Array.isArray(bomStructuresRaw)) setBomStructures(bomStructuresRaw);
        if (Array.isArray(subAssembliesRaw)) setSubAssemblies(subAssembliesRaw);
        if (Array.isArray(fieldedAssetsRaw)) setFieldedAssets(fieldedAssetsRaw);
        if (Array.isArray(stockLedgerRaw)) setStockLedgerEntries(stockLedgerRaw);
        if (Array.isArray(transactionsRaw) && transactionsRaw.length > 0) {
          setTransactions(transactionsRaw);
        } else {
          setTransactions(INITIAL_TRANSACTIONS);
        }
        if (Array.isArray(kitsRaw) && kitsRaw.length > 0) {
          setProductionKits(kitsRaw);
        } else {
          setProductionKits(INITIAL_PRODUCTION_KITS);
        }
      } catch (err) {
        console.error('Failed to load from API:', err);
      }
    };
    loadFromAPI();
  }, []);

  // Live clock updates
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const tzMatch = TIMEZONES.find(t => t.name === systemConfig.timezone || t.value === systemConfig.timezone);
      const tzVal = tzMatch ? tzMatch.value : 'UTC';

      const options: Intl.DateTimeFormatOptions = {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZone: tzVal
      };
      setDateTimeStr(now.toLocaleDateString('en-US', options).toUpperCase());
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, [systemConfig.timezone]);

  // Keyboard shortcut CMD+K / Ctrl+K focus search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        const searchInput = document.getElementById('search-input');
        if (searchInput) searchInput.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Sync animation handler
  const [syncRotated, setSyncRotated] = useState<boolean>(false);

  // Add Item handler
  const handleAddItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newItem.partNumber || !newItem.name) {
      alert('Please fill out the Part Number and Name fields.');
      return;
    }

    const createdItem: Item = {
      partNumber: newItem.partNumber,
      name: newItem.name,
      description: newItem.description || `${newItem.name} manufactured by ${newItem.manufacturer}`,
      manufacturer: newItem.manufacturer || 'Generic',
      stockLevel: Number(newItem.stockLevel),
      price: Number(newItem.price),
      supplier: newItem.supplier,
      category: newItem.category,
      status: newItem.status as any,
      size: newItem.size,
      sizeMetric: newItem.sizeMetric,
      bulkPriceZar: newItem.bulkPriceZar || Number((newItem.price * 19).toFixed(5)),
      packagingQuantity: newItem.packagingQuantity,
      packagingType: newItem.packagingType
    };

    const now = new Date();
    const newTrx: Transaction = {
      id: `TRX-${createdItem.partNumber}-${now.getTime()}`,
      itemPartNumber: createdItem.partNumber,
      itemName: createdItem.name,
      type: 'BOOK-IN',
      qtyChange: createdItem.stockLevel,
      reference: 'PO-NEW-INIT',
      performedBy: profile.name,
      performedByAvatar: profile.avatarUrl,
      dateTime: now.toISOString()
    };

    try {
      setSyncRotated(true);
      const payload = mapItemToPayload(createdItem);
      const res = await fetch(`${API_BASE}/api/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => 'unknown error');
        console.error('Failed to create item in DB:', res.status, text);
        await logActivity({
          userEmail: currentUser?.email || 'unknown',
          action: 'CREATE_ITEM',
          entityType: 'Item',
          entityId: createdItem.partNumber,
          status: 'ERROR',
          details: { error: text }
        });
        triggerToast("Failed to sync new item to database.");
        return;
      }

      await fetch('/api/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...newTrx, trxId: newTrx.id }),
      });

      setItems(prev => [createdItem, ...prev]);
      setTransactions(prev => [newTrx, ...prev]);
      await logActivity({
        userEmail: currentUser?.email || 'unknown',
        action: 'CREATE_ITEM',
        entityType: 'Item',
        entityId: createdItem.partNumber,
        details: { name: createdItem.name, price: createdItem.price, stockLevel: createdItem.stockLevel }
      });
      triggerToast(`Created component SKU: ${createdItem.partNumber}`);
    } catch (err) {
      console.error('Error syncing changes to DB:', err);
      await logActivity({
        userEmail: currentUser?.email || 'unknown',
        action: 'CREATE_ITEM',
        entityType: 'Item',
        entityId: createdItem.partNumber,
        status: 'ERROR',
        details: { error: (err as any).message }
      });
      triggerToast("Network error: Failed to sync changes.", "ERROR");
    } finally {
      setSyncRotated(false);
    }

    // Reset Form & close
    setNewItem({
      partNumber: '',
      name: '',
      description: '',
      manufacturer: '',
      stockLevel: 100,
      price: 0.00,
      supplier: 'Digi-Key Corp',
      category: 'Micro-ctrl',
      status: 'ACTIVE',
      size: '',
      sizeMetric: '',
      bulkPriceZar: 0.00
    });
    setShowAddModal(false);

    triggerToast(`Created component SKU: ${createdItem.partNumber}`);
  };

  const handleNewItemPriceChange = (usdVal: number) => {
    const zarVal = Number((usdVal * 19).toFixed(5));
    setNewItem(prev => ({
      ...prev,
      price: usdVal,
      bulkPriceZar: zarVal
    }));
  };

  const handleNewItemPriceZarChange = (zarVal: number) => {
    const usdVal = Number((zarVal / 19).toFixed(5));
    setNewItem(prev => ({
      ...prev,
      price: usdVal,
      bulkPriceZar: zarVal
    }));
  };

  const handleNewItemSizeChange = (impVal: string) => {
    const metricVal = deriveMetric(impVal);
    setNewItem(prev => ({
      ...prev,
      size: impVal,
      sizeMetric: metricVal || prev.sizeMetric
    }));
  };

  const handleNewItemSizeMetricChange = (metricVal: string) => {
    const impVal = deriveImperial(metricVal);
    setNewItem(prev => ({
      ...prev,
      sizeMetric: metricVal,
      size: impVal || prev.size
    }));
  };

  // Book In Item Handler
  const handleBookInItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bookInPartNumber) {
      alert('Please select or specify a valid Stock number.');
      return;
    }

    const qtyVal = Number(bookInQty);
    if (isNaN(qtyVal) || qtyVal <= 0) {
      alert('Please enter a valid quantity change greater than zero.');
      return;
    }

    // Find the item
    const targetItem = items.find(i => i.partNumber === bookInPartNumber);
    if (!targetItem) {
      alert(`SKU component "${bookInPartNumber}" not found in system.`);
      return;
    }

    // Create updated item object
    const updatedItem = { ...targetItem };
    updatedItem.stockLevel += qtyVal;
    updatedItem.description = bookInDescription || updatedItem.description;
    if (bookInUpdateStandardCost) {
      updatedItem.price = Number(bookInCost) || updatedItem.price;
    }

    if (bookInDiscontinued) {
      updatedItem.status = 'DISCONTINUED';
    } else if (updatedItem.status === 'DISCONTINUED') {
      updatedItem.status = 'ACTIVE'; // Re-activate
    }

    const now = new Date();
    const nowStr = now.toLocaleString('en-US', {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });

    // Create a transaction log
    const newTrx: Transaction = {
      id: `TRX-IN-${updatedItem.partNumber}-${now.getTime()}`,
      itemPartNumber: updatedItem.partNumber,
      itemName: updatedItem.name,
      type: 'BOOK-IN',
      qtyChange: qtyVal,
      reference: bookInDiscontinued ? 'PO-RE-ACTIVATION-DISCONTINUED' : 'PO-REPLENISHMENT-BOOK-IN',
      performedBy: profile.name,
      performedByAvatar: profile.avatarUrl,
      dateTime: nowStr,
      newCost: Number(bookInCost)
    };

    try {
      setSyncRotated(true);
      await saveItemToDB(updatedItem);
      await fetch('/api/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...newTrx, trxId: newTrx.id }),
      });

      setItems(prev => prev.map(i => i.partNumber === updatedItem.partNumber ? updatedItem : i));
      setTransactions(prev => [newTrx, ...prev]);
      triggerToast(`Booked in +${qtyVal} units for code SKU: ${updatedItem.partNumber}`);
    } catch (err) {
      console.error('Failed to sync booking data:', err);
      triggerToast("Failed to sync booking data to database.", "ERROR");
    } finally {
      setSyncRotated(false);
    }

    setShowBookInModal(false);
    setBookInUpdateStandardCost(false);
  };

  const API_BASE = '';

  const mapItemToPayload = (item: Item) => {
    const payload: Record<string, any> = {
      serial_number: item.partNumber,
      name: item.name,
      description: item.description,
      value: item.value,
      size: item.size,
      package: item.packageName,
      tolerance: item.tolerance,
      type: item.itemType || item.category,
      footprint: item.footprint,
      comment: item.comment,
      datasheet: item.datasheet,
      project: item.project,
      packaging: item.packaging,
      stock: item.stockLevel,
      low_stock_lvl: item.lowStockLvl,
      current_cost_dollar: item.price,
      bulk_price_usd: item.bulkPriceUsd,
      bulk_price_zar: item.bulkPriceZar,
      last_order_qty: item.lastOrderQty,
      last_order_date: item.lastOrderDate,
      status: item.status,
      man_pn_1: item.manPns?.[0] || item.manufacturer,
      man_pn_2: item.manPns?.[1] || '',
      man_pn_3: item.manPns?.[2] || '',
      man_pn_4: item.manPns?.[3] || '',
      man_pn_5: item.manPns?.[4] || '',
      sup_pn_1: item.supPns?.[0] || item.supplier,
      sup_pn_2: item.supPns?.[1] || '',
      sup_pn_3: item.supPns?.[2] || '',
      sup_pn_4: item.supPns?.[3] || '',
      sup_pn_5: item.supPns?.[4] || '',
      weblink_1: item.weblinks?.[0] || '',
      weblink_2: item.weblinks?.[1] || '',
      weblink_3: item.weblinks?.[2] || '',
      weblink_4: item.weblinks?.[3] || '',
      weblink_5: item.weblinks?.[4] || '',
    };
    Object.keys(payload).forEach(k => (payload[k] === undefined || payload[k] === null) && delete payload[k]);
    return payload;
  };

  const saveItemToDB = async (item: Item) => {
    try {
      const payload = mapItemToPayload(item);
      const res = await fetch(`${API_BASE}/api/items/${encodeURIComponent(item.partNumber)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => 'unknown error');
        console.error('Failed to persist item to DB:', res.status, text);
      }
    } catch (err) {
      console.error('Error saving item to DB:', err);
    }
  };

  const handleSaveSupplier = async (supplier: Supplier) => {
    try {
      setSyncRotated(true);
      const isNew = !suppliers.find(s => s.id === supplier.id);
      const payload = {
        id: supplier.id,
        name: supplier.name,
        website: supplier.website,
        contact_email: supplier.contact_email,
        notes: supplier.notes,
        lead_time: supplier.leadTime,
        response_time: supplier.responseTime,
      };
      const res = await fetch('/api/suppliers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('Failed to save supplier');

      setSuppliers(prev => {
        const exists = prev.find(s => s.id === supplier.id);
        if (exists) {
          return prev.map(s => s.id === supplier.id ? supplier : s);
        }
        return [supplier, ...prev];
      });
      await logActivity({
        userEmail: currentUser?.email || 'unknown',
        action: isNew ? 'CREATE_SUPPLIER' : 'UPDATE_SUPPLIER',
        entityType: 'Supplier',
        entityId: supplier.id,
        details: { name: supplier.name, website: supplier.website }
      });
      triggerToast(`Supplier ${supplier.name} saved successfully.`);
      setShowSupplierModal(false);
    } catch (err) {
      console.error('Error saving supplier:', err);
      await logActivity({
        userEmail: currentUser?.email || 'unknown',
        action: 'CREATE_SUPPLIER',
        entityType: 'Supplier',
        entityId: supplier.id,
        status: 'ERROR',
        details: { error: (err as any).message }
      });
      triggerToast('Failed to save supplier', 'ERROR');
    } finally {
      setSyncRotated(false);
    }
  };

  // Save edited item details
  const handleSaveItemDetail = async (updatedItem: Item) => {
    try {
      setSyncRotated(true);
      await saveItemToDB(updatedItem);
      setItems(prev => prev.map(i => i.partNumber === updatedItem.partNumber ? updatedItem : i));
      await logActivity({
        userEmail: currentUser?.email || 'unknown',
        action: 'UPDATE_ITEM',
        entityType: 'Item',
        entityId: updatedItem.partNumber,
        details: { name: updatedItem.name, price: updatedItem.price, status: updatedItem.status }
      });
      triggerToast(`Successfully saved parameters for SKU: ${updatedItem.partNumber}`);
    } catch (err) {
      console.error('Failed to save item detail:', err);
      await logActivity({
        userEmail: currentUser?.email || 'unknown',
        action: 'UPDATE_ITEM',
        entityType: 'Item',
        entityId: updatedItem.partNumber,
        status: 'ERROR',
        details: { error: (err as any).message }
      });
      triggerToast("Error: Failed to save changes to database.", "ERROR");
    } finally {
      setSyncRotated(false);
    }
  };

  // Wholesale 1000-unit bulk pricing state updater
  const handleUpdateBulkPrices = async (updatedPrices: { partNumber: string; price: number }[]) => {
    const priceMap = new Map(updatedPrices.map(u => [u.partNumber, u.price]));
    const affectedItems: Item[] = [];

    const newItems = items.map(item => {
      if (priceMap.has(item.partNumber)) {
        const updated = {
          ...item,
          price: priceMap.get(item.partNumber)!
        };
        affectedItems.push(updated);
        return updated;
      }
      return item;
    });

    if (affectedItems.length === 0) return;

    try {
      const payloads = affectedItems.map(i => mapItemToPayload(i));
      const res = await fetch(`${API_BASE}/api/items/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloads),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => 'unknown error');
        console.error('Failed to persist bulk prices to DB:', res.status, text);
        triggerToast("Failed to save price updates to database.");
        return;
      }

      setItems(newItems);
      triggerToast("Bulk prices successfully synchronized.");
    } catch (err) {
      console.error('Error saving bulk prices to DB:', err);
      triggerToast("Network error: Bulk price update failed.");
    }
  };

  // Robust client-side CSV parser
  const parseCSVData = (text: string) => {
    const lines = text.trim().split('\n');
    if (lines.length === 0) return [];

    // Autodetect delimiter: semicolon or comma
    const headerLine = lines[0];
    const delimiter = headerLine.includes(';') ? ';' : ',';

    const parsed: Item[] = [];
    const seenParts = new Set<string>();

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const cols = line.split(delimiter).map(col => col.trim().replace(/^["']|["']$/g, ''));
      if (cols.length < 2) continue;

      const partNumber = cols[0] || '';
      if (!partNumber || seenParts.has(partNumber)) continue;
      seenParts.add(partNumber);

      const name = cols[1] || 'Unnamed Item';
      const description = cols[2] || '';
      const value = cols[3] || '';
      const size = cols[4] || '';
      const packageName = cols[5] || '';
      const tolerance = cols[6] || '';
      const itemType = cols[7] || '';
      const footprint = cols[8] || '';
      const comment = cols[9] || '';
      const datasheet = cols[10] || '';
      const project = cols[11] || '';
      const packaging = cols[12] || '';

      const stockLevel = parseInt(cols[13]) || 0;
      const lowStockLvl = parseInt(cols[15]) || 50;

      let price = parseFloat(cols[16]) || parseFloat(cols[17]) || 0.0;
      if (!price && cols[18]) {
        price = (parseFloat(cols[18]) || 0.0) / 18.0;
      }
      if (price <= 0) {
        price = 0.50;
      }

      const manufacturer = cols[21] || cols[22] || 'Generic';

      // Category classifier - prioritize CSV type column, fallback to SKU prefix
      let category = itemType;
      if (!category || category === 'Components' || category === 'Unknown') {
        if (partNumber.startsWith('ANT-')) category = 'Antennas';
        else if (partNumber.startsWith('CAP-')) category = 'Capacitors';
        else if (partNumber.startsWith('RES-')) category = 'Resistors';
        else if (partNumber.startsWith('CHP-')) category = 'ICs';
        else if (partNumber.startsWith('CON-')) category = 'Connectors';
        else if (partNumber.startsWith('LED')) category = 'LEDs';
        else if (partNumber.startsWith('TRA-')) category = 'Transistors';
        else if (partNumber.startsWith('ZEN-')) category = 'Zeners';
        else if (partNumber.startsWith('DIO-')) category = 'Diodes';
        else if (partNumber.startsWith('TUL-')) category = 'Tools';
        else if (partNumber.startsWith('ASS-')) category = 'Sub-Assemblies';
        else if (partNumber.startsWith('BAT-')) category = 'Batteries';
        else category = category || 'Components';
      }

      let status: 'ACTIVE' | 'INACTIVE' | 'BOOKED OUT' | 'DISCONTINUED' = 'ACTIVE';
      if (stockLevel === 0) {
        status = 'BOOKED OUT';
      } else if (stockLevel < lowStockLvl) {
        status = 'INACTIVE';
      }

      if (description?.toLowerCase().includes('discontinued') || description?.toLowerCase().includes('not used')) {
        status = 'DISCONTINUED';
      }

      parsed.push({
        partNumber,
        name,
        description,
        manufacturer,
        stockLevel,
        price,
        category,
        status,
        value,
        size,
        packageName,
        tolerance,
        itemType,
        footprint,
        comment,
        datasheet,
        project,
        packaging,
        lowStockLvl
      });
    }

    return parsed;
  };

  const handleApplyImport = async () => {
    if (csvParsedPreview.length === 0) return;

    const mergedMap = new Map<string, Item>();
    items.forEach(item => mergedMap.set(item.partNumber, item));
    csvParsedPreview.forEach(item => mergedMap.set(item.partNumber, item));
    const combined = Array.from(mergedMap.values());

    const now = new Date();
    const newTransactions: Transaction[] = csvParsedPreview
      .filter(item => item.stockLevel > 0)
      .slice(0, 10)
      .map((item, idx) => ({
        id: `TRX-IMP-${item.partNumber}-${now.getTime()}-${idx}`,
        itemPartNumber: item.partNumber,
        itemName: item.name,
        type: 'BOOK-IN' as any,
        qtyChange: item.stockLevel,
        reference: 'CSV Bulk Import',
        performedBy: profile.name,
        performedByAvatar: profile.avatarUrl,
        dateTime: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + `, ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`
      }));

    try {
      // Bulk update items
      const payloads = csvParsedPreview.map(i => mapItemToPayload(i));
      const res = await fetch(`${API_BASE}/api/items/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloads),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => 'unknown error');
        console.error('Failed to persist imported items to DB:', res.status, text);
        triggerToast("Failed to sync imported items to database.");
        return;
      }

      // Save transactions
      for (const trx of newTransactions) {
        await fetch('/api/transactions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...trx, trxId: trx.id }),
        });
      }

      setItems(combined);
      if (newTransactions.length > 0) {
        setTransactions(prev => [...newTransactions, ...prev]);
      }
      triggerToast(`Successfully imported ${csvParsedPreview.length} inventory items!`);
    } catch (err) {
      console.error('Error saving imported items to DB:', err);
      triggerToast("Network error during import synchronization.");
    }
    setShowImportModal(false);
    setCsvFileContent('');
    setCsvParsedPreview([]);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingCsv(true);
  };

  const handleDragLeave = () => {
    setIsDraggingCsv(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingCsv(false);
    const file = e.dataTransfer.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const text = event.target?.result as string;
        setCsvFileContent(text);
        const parsed = parseCSVData(text);
        setCsvParsedPreview(parsed);
      };
      reader.readAsText(file);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const text = event.target?.result as string;
        setCsvFileContent(text);
        const parsed = parseCSVData(text);
        setCsvParsedPreview(parsed);
      };
      reader.readAsText(file);
    }
  };

  const loadDefaultCSV = () => {
    setCsvFileContent(CSV_HEADER);
    const parsed = parseCSVData(CSV_HEADER);
    setCsvParsedPreview(parsed);
  };

  // Save Settings handler
  const handleSaveSettings = async () => {
    setIsSavingSettings(true);
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(systemConfig),
      });
      triggerToast('Configurations successfully applied to database.');
    } catch (err) {
      console.error('Failed to save settings:', err);
    } finally {
      setIsSavingSettings(false);
    }
  };

  // Export CSV Simulated Action
  const handleExportCSV = (fileName: string) => {
    triggerToast(`Exported ledger data to ${fileName}.csv`);
  };

  // Dynamic STM32 Search Routing
  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setSearchQuery(val);
    if (val.trim() !== '') {
      setView('search');
    } else {
      setView('dashboard');
    }
  };

  React.useEffect(() => {
    setCsvFileContent(prev => {
      if (prev === '') return prev;
      return generateCSVFromItems(items);
    });
  }, [items]);


  // --- ADDED DYNAMIC FILTER LOGIC ---
  const filteredItems = React.useMemo(() => {
    return items.filter(item => {
      const matchesSearch =
        item.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.partNumber?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (item.manufacturer && item.manufacturer.toLowerCase().includes(searchQuery.toLowerCase()));

      const matchesStatus = selectedStatus === 'ALL' || item.status === selectedStatus;

      let matchesStock = true;
      if (selectedStockStatus === 'LOW') matchesStock = item.stockLevel > 0 && item.stockLevel < 19;
      if (selectedStockStatus === 'CRITICAL') matchesStock = item.stockLevel === 0;
      if (selectedStockStatus === 'OK') matchesStock = item.stockLevel >= 19;

      const itemPrefix = item.partNumber?.split('-')[0]?.toUpperCase() || '';
      const matchesType = selectedItemType === 'ALL' || itemPrefix === selectedItemType;

      return matchesSearch && matchesStatus && matchesStock && matchesType;
    });
  }, [items, searchQuery, selectedStatus, selectedStockStatus, selectedItemType]);

  // Dynamically compile every unique 3-letter prefix code from the items array
  const availablePrefixes = React.useMemo(() => {
    const prefixes = new Set<string>();
    items.forEach(item => {
      if (item.partNumber && item.partNumber.includes('-')) {
        const prefix = item.partNumber.split('-')[0].toUpperCase().trim();
        if (prefix.length === 3) {
          prefixes.add(prefix);
        }
      }
    });
    return Array.from(prefixes).sort();
  }, [items]);

  const filteredTrx = transactions.filter(
    t =>
      String(t.id).toLowerCase().includes(searchQuery.toLowerCase()) ||
      String(t.itemName).toLowerCase().includes(searchQuery.toLowerCase()) ||
      String(t.itemPartNumber).toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredSuppliers = suppliers.filter(
    s =>
      s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (s.notes && s.notes.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  // Totals calculations
  const totalItemsCount = items.length;
  const totalValuation = items.reduce((acc, curr) => acc + (curr.stockLevel * curr.price), 0);

  // Explicitly isolate warning levels (between 19 and 48 inclusive)
  const lowStockCount = items.filter(i => i.stockLevel >= 19 && i.stockLevel < 49).length;
  const criticalCount = items.filter(i => i.stockLevel < 19).length;
  // Dynamic status breakdown calculations
  const okCount = Math.max(0, totalItemsCount - lowStockCount - criticalCount);

  const okPercent = totalItemsCount > 0 ? Math.round((okCount / totalItemsCount) * 100) : 0;
  const lowPercent = totalItemsCount > 0 ? Math.round((lowStockCount / totalItemsCount) * 100) : 0;

  // Dynamically extract stock code prefixes from actual data
  const getStockPrefix = (stockCode?: string): string => {
    if (!stockCode) return 'Other';
    // Try 3-letter prefix pattern first
    let match = stockCode.match(/^([A-Z]{2,4})-/);
    if (match) return match[1];
    // Fallback to first 3 characters
    return stockCode.substring(0, 3);
  };

  // Group items by stock code prefix and sum stock levels
  const prefixGroups = Array.from(
    new Set(items.map(i => getStockPrefix(i.partNumber)))
  ).sort();

  const categoryCounts = prefixGroups.map(prefix => {
    const count = items
      .filter(i => getStockPrefix(i.partNumber) === prefix)
      .reduce((sum, item) => sum + (item.stockLevel || 0), 0);
    const skuCount = items.filter(i => getStockPrefix(i.partNumber) === prefix).length;
    return { cat: prefix, count, skuCount };
  }).sort((a, b) => b.count - a.count);

  // Determine the maximum count value to safely scale heights proportionally
  const maxCategoryCount = Math.max(...categoryCounts.map(c => c.count), 1);

  // Force the remainder onto critical to ensure they always aggregate to a clean 100%
  const criticalPercent = totalItemsCount > 0 ? 100 - okPercent - lowPercent : 0;
  const detailItem = items.find(i => i.partNumber === selectedDetailPartNumber);

  // Show login screen if not authenticated
  if (!isAuthenticated) {
    return <Login onLogin={handleLogin} isLoading={isLoginLoading} />;
  }

  return (
    <div
      className={`min-h-screen text-on-surface font-sans flex ${systemConfig.visualTheme === 'light' ? 'light-mode bg-[#F8FAFC]' : 'dark-mode bg-[#10131a]'
        }`}
      style={{
        // Set variables dynamically in light/dark style wrappers
        colorScheme: systemConfig.visualTheme
      }}
    >
      <Sidebar
        currentView={currentView}
        setView={(v) => { setView(v); setSearchQuery(''); }}
        appName="Tracklab IM"
        isSidebarOpen={isSidebarOpen}
        setIsSidebarOpen={setIsSidebarOpen}
        profile={profile}
      />

      {/* Sidebar Overlay for Mobile */}
      {isSidebarOpen && (
        <div
          className="fixed inset-0 bg-background/60 backdrop-blur-sm z-40 lg:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Main Content Area */}
      <main className="lg:pl-64 flex-1 flex flex-col min-h-screen relative overflow-y-auto w-full transition-all duration-300">

        {/* TopNavBar Header */}
        <header className="h-16 flex justify-between items-center px-4 md:px-container-margin sticky top-0 z-40 bg-surface/80 backdrop-blur-md border-b border-outline-variant gap-4">
          <div className="flex items-center gap-xl flex-1 min-w-0">
            <button
              onClick={() => setIsSidebarOpen(true)}
              className="lg:hidden p-2 -ml-2 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high rounded-lg transition-colors"
            >
              <Menu className="w-5 h-5" />
            </button>
            <h2 className="font-headline-md text-xl font-black text-primary select-none flex items-center capitalize gap-sm tracking-tighter leading-none">
              {currentView.replace('_', ' ')}
            </h2>

            {/* Quick search input */}
            <div className="hidden md:flex items-center bg-surface-container-high rounded-full px-md py-1 border border-outline-variant w-96 font-mono text-[13px]">
              <Search className="text-outline w-4 h-4 mr-sm shrink-0" />
              <input
                id="search-input"
                className="bg-transparent border-none focus:outline-none focus:ring-0 text-xs w-full text-on-surface"
                placeholder="Search SKU, name, ID... (⌘K)"
                type="text"
                value={searchQuery}
                onChange={handleSearchChange}
              />
              <span className="text-[10px] text-outline ml-sm opacity-50 bg-surface-container-lowest px-1.5 py-0.5 rounded border border-outline-variant">
                ⌘K
              </span>
            </div>
          </div>

          {/* Quick Operations Actions */}
          <div className="flex items-center gap-2 select-none shrink-0">
            <button
              onClick={handleStockSync}
              className="p-1.5 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high rounded-lg transition-all duration-200 flex items-center justify-center border border-transparent hover:border-outline-variant/40"
              title="Sync Stock Data"
            >
              <RefreshCw className={`w-4 h-4 ${syncRotated ? 'animate-spin text-primary' : ''}`} />
            </button>

            <button
              onClick={() => handleExportCSV('tracklab_report')}
              className="p-1.5 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high rounded-lg transition-all duration-200 flex items-center justify-center border border-transparent hover:border-outline-variant/40"
              title="Export Table Data"
            >
              <Download className="w-4 h-4" />
            </button>

            <div className="h-4 w-px bg-outline-variant mx-1 self-center"></div>

            <button
              onClick={handleStockSync}
              className="bg-surface-container-high border border-outline-variant text-on-surface px-3 py-1.5 rounded-lg font-bold text-xs hover:bg-surface-container-highest active:scale-95 transition-all duration-150"
            >
              Sync Stock
            </button>

            <button
              onClick={() => {
                if (items.length > 0) {
                  const firstItem = items[0];
                  setBookInPartNumber(firstItem.partNumber);
                  setBookInDescription(firstItem.description);
                  setBookInCost(firstItem.price);
                  setBookInDiscontinued(firstItem.status === 'DISCONTINUED');
                }
                setShowBookInModal(true);
              }}
              className="bg-secondary text-white px-3 py-1.5 rounded-lg font-bold text-xs hover:brightness-110 active:scale-95 transition-all duration-150 flex items-center gap-1.5 shadow-md shadow-secondary/10"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Book In Component
            </button>

            <button
              onClick={() => setShowAddModal(true)}
              className="bg-primary text-white px-3 py-1.5 rounded-lg font-bold text-xs shadow-md shadow-primary/10 hover:brightness-110 active:scale-95 transition-all duration-150 flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Item
            </button>

            <div className="h-4 w-px bg-outline-variant mx-1 self-center"></div>

            {/* User Profile & Logout */}
            <div className="flex items-center gap-2">
              <div className="text-right hidden sm:block">
                <p className="text-xs font-bold text-on-surface">{currentUser?.firstName || 'User'}</p>
                <p className="text-[10px] text-on-surface-variant capitalize">{currentUser?.role || 'viewer'}</p>
              </div>
              <button
                onClick={handleLogout}
                className="p-2 text-on-surface-variant hover:text-error hover:bg-error/10 rounded-lg transition-all duration-200 border border-transparent hover:border-error/30"
                title="Logout"
              >
                <User className="w-4 h-4" />
              </button>
            </div>
          </div>
        </header>

        {/* Dynamic Inner Contents */}
        <div className="flex-1">
          {(() => {
            if (currentView === 'dashboard') {
              return (
                <DashboardView
                  items={items}
                  dateTimeStr={dateTimeStr}
                  lowStockCount={lowStockCount}
                  criticalCount={criticalCount}
                  setView={setView}
                  totalItemsCount={totalItemsCount}
                  totalValuation={totalValuation}
                  okPercent={okPercent}
                  lowPercent={lowPercent}
                  criticalPercent={criticalPercent}
                  categoryCounts={categoryCounts}
                  maxCategoryCount={maxCategoryCount}
                  sparklineCoords={sparklineCoords}
                />
              );
            }

            if (currentView === 'kit_booking') {
              return (
                <KitBookingView
                  projects={projects}
                  triggerToast={triggerToast}
                />
              );
            }

            if (currentView === 'items') {
              return (
                <InventoryView
                  items={items}
                  searchQuery={searchQuery}
                  setSearchQuery={setSearchQuery}
                  selectedItemType={selectedItemType}
                  setSelectedItemType={setSelectedItemType}
                  selectedStatus={selectedStatus}
                  setSelectedStatus={setSelectedStatus}
                  selectedStockStatus={selectedStockStatus}
                  setSelectedStockStatus={setSelectedStockStatus}
                  sortBy={sortBy}
                  setSortBy={setSortBy}
                  availablePrefixes={availablePrefixes}
                  filteredItems={filteredItems}
                  setSelectedDetailPartNumber={setSelectedDetailPartNumber}
                  handleResetFilters={handleResetFilters}
                  setShowImportModal={setShowImportModal}
                  setShowAddModal={setShowAddModal}
                />
              );
            }

            if (currentView === 'stock_kits') {
              return (
                <StockTablesView
                  selectedTableTab={selectedTableTab}
                  setSelectedTableTab={setSelectedTableTab}
                  productionKits={productionKits}
                  setIsKitModalOpen={setIsKitModalOpen}
                  handleExportCSV={handleExportCSV}
                  projects={projects}
                  onEditKit={(kit) => {
                    setEditingKit(kit);
                    setIsKitModalOpen(true);
                  }}
                />
              );
            }

            if (currentView === 'reports_ledger') {
              return (
                <LedgerView
                  ledgerFilter={ledgerFilter}
                  setLedgerFilter={setLedgerFilter}
                  ledgerSort={ledgerSort}
                  setLedgerSort={setLedgerSort}
                  transactions={transactions}
                  handleExportCSV={handleExportCSV}
                  triggerToast={triggerToast}
                />
              );
            }

            if (currentView === 'pricing') {
              return (
                <PricingView
                  pricingFilter={pricingFilter}
                  setPricingFilter={setPricingFilter}
                  items={items}
                  handleUpdateBulkPrices={handleUpdateBulkPrices}
                  triggerToast={triggerToast}
                  setSelectedDetailPartNumber={setSelectedDetailPartNumber}
                  setView={setView}
                />
              );
            }

            if (currentView === 'suppliers') {
              return (
                <SuppliersView
                  suppliers={suppliers}
                  setShowSupplierModal={setShowSupplierModal}
                  setEditingSupplier={setEditingSupplier}
                />
              );
            }

            if (currentView === 'bulk_pricing') {
              return (
                <BulkPricingWizard
                  items={items}
                  onUpdatePrices={handleUpdateBulkPrices}
                  onShowNotification={triggerToast}
                  onClose={() => setView('pricing')}
                />
              );
            }

            if (currentView === 'production_kits') {
              return (
                <ProductionKitsManager
                  onKitCreated={handleNewKitCreation}
                  onBatchKitsUploaded={handleBatchKitsImport}
                  triggerToast={triggerToast}
                  projects={projects}
                  editingKit={editingKit}
                  onCancelEdit={() => setEditingKit(null)}
                />
              );
            }

            if (currentView === 'search') {
              return (
                <SearchView
                  searchQuery={searchQuery}
                  setSearchQuery={setSearchQuery}
                  filteredItems={filteredItems}
                  filteredTrx={filteredTrx}
                  filteredSuppliers={filteredSuppliers}
                  setShowAddModal={setShowAddModal}
                />
              );
            }

            if (currentView === 'settings') {
              return (
                <SettingsView
                  systemConfig={systemConfig}
                  setSystemConfig={setSystemConfig}
                  setProfile={setProfile}
                  TIMEZONES={TIMEZONES}
                  handleSaveSettings={handleSaveSettings}
                  isSavingSettings={isSavingSettings}
                  triggerToast={triggerToast}
                />
              );
            }

            if (currentView === 'profile') {
              return (
                <ProfileView
                  profile={profile}
                  setProfile={setProfile}
                  systemConfig={systemConfig}
                  setSystemConfig={setSystemConfig}
                  TIMEZONES={TIMEZONES}
                  triggerToast={triggerToast}
                  handleStockSync={handleStockSync}
                />
              );
            }

            if (currentView === 'activity-logs') {
              return <ActivityLogsView currentUserEmail={currentUser?.email} />;
            }

            if (currentView === 'bom_manager') {
              return (
                <BOMManager
                  items={items}
                  setItems={setItems}
                  transactions={transactions}
                  setTransactions={setTransactions}
                  projects={projects}
                  bomItems={bomItems}
                  triggerToast={triggerToast}
                  onItemClick={setSelectedDetailPartNumber}
                />
              );
            }

            if (currentView === 'pick_place') {
              return (
                <PickPlaceManager
                  projects={projects}
                  ppItems={ppItems}
                  triggerToast={triggerToast}
                  onItemClick={setSelectedDetailPartNumber}
                />
              );
            }

if (currentView === 'alternates') {
               return (
                 <AlternatesManager
                   items={items}
                   triggerToast={triggerToast}
                   onItemClick={setSelectedDetailPartNumber}
                 />
               );
             }

             if (currentView === 'projects') {
               return (
                 <ProjectsView
                   projects={projects}
                   items={items}
                   projectReadiness={projectReadiness}
                   projectPlacementStats={projectPlacementStats}
                   jobCards={jobCards}
                   triggerToast={triggerToast}
                   onProjectCreated={(project) => {
                     setProjects(prev => [...prev, project]);
                     const isTestEnv = window.navigator.webdriver || window.location.search.includes('test');
                     if (!isTestEnv) {
                       fetchProjectReadiness(project.id);
                     }

                     // Log activity asynchronously without blocking creation
                     if (currentUser?.email) {
                       logActivity({
                         userEmail: currentUser.email,
                         action: 'CREATE_PROJECT',
                         entityType: 'Project',
                         entityId: String(project.id),
                         details: { projectName: project.projectName, status: project.status }
                       }).catch(err => {
                         console.error('Failed to log project creation:', err);
                         // Silently ignore activity log errors - don't let them break project creation
                       });
                     }
                   }}
                   onProjectDeleted={(id) => {
                     const deletedProject = projects.find(p => p.id === id);
                     setProjects(prev => prev.filter(p => p.id !== id));

                     // Log activity asynchronously without blocking deletion
                     if (deletedProject && currentUser?.email) {
                       logActivity({
                         userEmail: currentUser.email,
                         action: 'DELETE_PROJECT',
                         entityType: 'Project',
                         entityId: String(id),
                         details: { projectName: deletedProject.projectName }
                       }).catch(err => console.error('Failed to log project deletion:', err));
                     }
                   }}
                   onProjectUpdated={(project) => {
                     setProjects(prev => prev.map(p => p.id === project.id ? project : p));
                     const isTestEnv = window.navigator.webdriver || window.location.search.includes('test');
                     if (!isTestEnv) {
                       fetchProjectReadiness(project.id);
                     }

                     // Log activity asynchronously without blocking update
                     if (currentUser?.email) {
                       logActivity({
                         userEmail: currentUser.email,
                         action: 'UPDATE_PROJECT',
                         entityType: 'Project',
                         entityId: String(project.id),
                         details: { projectName: project.projectName, status: project.status }
                       }).catch(err => console.error('Failed to log project update:', err));
                     }
                   }}
                 />
               );
             }

             if (currentView === 'bookkeeping') {
               return (
                 <BookkeepingView
                   clients={clients}
                   setClients={setClients}
                   clientOrders={clientOrders}
                   setClientOrders={setClientOrders}
                   buildJobs={buildJobs}
                   setBuildJobs={setBuildJobs}
                   bomStructures={bomStructures}
                   setBomStructures={setBomStructures}
                   subAssemblies={subAssemblies}
                   setSubAssemblies={setSubAssemblies}
                   clientOrderItems={clientOrderItems}
                   setClientOrderItems={setClientOrderItems}
                   fieldedAssets={fieldedAssets}
                   setFieldedAssets={setFieldedAssets}
                   stockLedgerEntries={stockLedgerEntries}
                   setStockLedgerEntries={setStockLedgerEntries}
                   items={items}
                   suppliers={suppliers}
                   triggerToast={triggerToast}
                 />
               );
             }

             if (currentView === 'production_costs') {
               return <ProductionCostsView triggerToast={triggerToast} />;
             }

             if (currentView === 'automation') {
               return <AutomationDashboard triggerToast={triggerToast} />;
             }

             if (currentView === 'auto_po_config') {
               return <AutoPOConfigView triggerToast={triggerToast} />;
             }

             if (currentView === 'quality_compliance') {
               return <QualityComplianceDashboard triggerToast={triggerToast} />;
             }

             if (currentView === 'advanced_automation') {
               return <AdvancedAutomationDashboard triggerToast={triggerToast} />;
             }

             return null;
           })()}
        </div>

        {/* System bottom absolute metadata footer */}
        <footer className="mt-auto h-10 bg-surface-container-lowest border-t border-outline-variant flex items-center justify-between px-lg text-[10px] text-outline font-mono select-none">
          <div className="flex gap-4">
            <div className="inline-flex items-center gap-1">
              <span>SYSTEM STATUS: <span className="text-[#4ade80] font-bold">OPTIMAL</span></span>
            </div>
            <span>SYNC DATA STREAM: 0.4s AGO</span>
            <span>ENCRYPT NODE: AES-256</span>
          </div>
          <div>© 2026 TRACKLAB IM | ALL SYSTEMS OPERATIONAL</div>
        </footer>

        {/* Global floating notification Toast system */}
        {showToast && (
          <div
            onClick={() => setShowToast(false)}
            className="fixed bottom-[24px] right-[24px] glass-panel px-lg py-md rounded-xl shadow-2xl border-primary/40 transform transition-all duration-300 z-50 flex items-center gap-md cursor-pointer translate-y-0 opacity-100"
          >
            <span className="w-2 h-2 rounded-full bg-green-500 animate-ping shrink-0"></span>
            <span className="text-xs font-bold font-sans">
              {toastMessage}
            </span>
          </div>
        )}

        {/* Integrated Modal Form for adding new SKUs */}
        {showAddModal && (
          <div className="fixed inset-0 bg-background/80 backdrop-blur-xs flex items-center justify-center z-100 p-md">
            <div className="bg-surface-container rounded-xl border border-outline-variant max-w-[448px] w-full p-lg shadow-2xl relative">
              <button
                onClick={() => setShowAddModal(false)} aria-label="Close modal"
                className="absolute top-sm right-sm text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high p-1.5 rounded-lg transition-colors"
              >
                <X className="w-4 h-4" />
              </button>

              <h4 className="font-headline-sm text-lg font-black text-primary block mb-md select-none tracking-tighter leading-none">
                Register New Inventory Component SKU
              </h4>

              <form onSubmit={handleAddItem} className="space-y-sm text-xs">
                <div className="flex flex-col gap-1">
                  <label className="font-bold text-outline">SKU Part Number Designation</label>
                  <input
                    name="partNumber"
                    placeholder="e.g. STM32G031F6P6"
                    className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary font-mono text-xs uppercase"
                    type="text"
                    required
                    value={newItem.partNumber}
                    onChange={(e) => setNewItem({ ...newItem, partNumber: e.target.value })}
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label className="font-bold text-outline">Component Human Friendly Name</label>
                  <input
                    name="name"
                    placeholder="e.g. STM32 Microcontroller Core"
                    className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary font-semibold text-xs"
                    type="text"
                    required
                    value={newItem.name}
                    onChange={(e) => setNewItem({ ...newItem, name: e.target.value })}
                  />
                </div>

                <div className="grid grid-cols-2 gap-sm">
                  <div className="flex flex-col gap-1">
                    <label className="font-bold text-outline">Category Class</label>
                    <select aria-label="Filter"
                      name="category"
                      className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none"
                      value={newItem.category}
                      onChange={(e) => setNewItem({ ...newItem, category: e.target.value })}
                    >
                      <option value="">Select Category</option>
                      <option>Resistor</option>
                      <option>Capacitor</option>
                      <option>IC (Integrated Circuit)</option>
                      <option>Diode</option>
                      <option>Transistor</option>
                      <option>Connector</option>
                      <option>LED</option>
                      <option>Inductor</option>
                      <option>Crystal / Oscillator</option>
                      <option>Button / Tactile Switch</option>
                      <option>Sensors</option>
                      <option>Hardware / Other</option>
                      <option>Antenna</option>
                      <option>Sub-Assembly</option>
                      <option>Battery</option>
                      <option>Box</option>
                      <option>Bracket</option>
                      <option>Kit</option>
                      <option>Buzzer</option>
                      <option>Cable / Flylead</option>
                      <option>Coax</option>
                      <option>Jumper</option>
                      <option>Fibre</option>
                      <option>Ethernet</option>
                      <option>Product</option>
                      <option>Consumable</option>
                      <option>Tool</option>
                    </select>
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="font-bold text-outline">Preferred Supplier</label>
                    <select aria-label="Filter"
                      className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none"
                      value={newItem.supplier}
                      onChange={(e) => setNewItem({ ...newItem, supplier: e.target.value })}
                    >
                      <option value="">Select Supplier</option>
                      {suppliers.map(sup => (
                        <option key={sup.id} value={sup.name}>{sup.name}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-xs">
                  <div className="flex flex-col gap-1 col-span-1">
                    <label className="font-bold text-outline">Initial Stock Qty</label>
                    <input
                      name="stockLevel"
                      className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none font-mono text-xs"
                      type="number"
                      min="1"
                      required
                      value={newItem.stockLevel}
                      onChange={(e) => setNewItem({ ...newItem, stockLevel: Number(e.target.value) })}
                    />
                  </div>

                  <div className="flex flex-col gap-1 col-span-1">
                    <label className="font-bold text-outline">Unit Price ($ USD)</label>
                    <input
                      name="price"
                      className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none font-mono text-xs"
                      type="number"
                      step="0.0001"
                      min="0"
                      required
                      value={newItem.price}
                      onChange={(e) => handleNewItemPriceChange(Number(e.target.value))}
                    />
                  </div>

                  <div className="flex flex-col gap-1 col-span-1">
                    <label className="font-bold text-outline">Unit Cost (R ZAR)</label>
                    <input
                      name="bulkPriceZar"
                      className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none font-mono text-xs"
                      type="number"
                      step="0.0001"
                      min="0"
                      required
                      value={newItem.bulkPriceZar || Number((newItem.price * 19).toFixed(5))}
                      onChange={(e) => handleNewItemPriceZarChange(Number(e.target.value))}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-sm">
                  <div className="flex flex-col gap-1">
                    <label className="font-bold text-outline">Package Size (Imperial)</label>
                    <input
                      placeholder="e.g. 0603"
                      className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none font-mono text-xs"
                      type="text"
                      value={newItem.size}
                      onChange={(e) => handleNewItemSizeChange(e.target.value)}
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="font-bold text-outline">Package Size (Metric)</label>
                    <input
                      placeholder="e.g. 1608"
                      className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none font-mono text-xs"
                      type="text"
                      value={newItem.sizeMetric}
                      onChange={(e) => handleNewItemSizeMetricChange(e.target.value)}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-sm">
                  <div className="flex flex-col gap-1">
                    <label className="font-bold text-outline">Packaging Quantity</label>
                    <input
                      placeholder="e.g. 1, 5, 10"
                      className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none font-mono text-xs"
                      type="number"
                      min="1"
                      value={newItem.packagingQuantity}
                      onChange={(e) => setNewItem({ ...newItem, packagingQuantity: Number(e.target.value) })}
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="font-bold text-outline">Packaging Type</label>
                    <select
                      className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none"
                      value={newItem.packagingType}
                      onChange={(e) => setNewItem({ ...newItem, packagingType: e.target.value })}
                    >
                      <option value="packet">Packet</option>
                      <option value="reel">Reel</option>
                      <option value="tray">Tray</option>
                      <option value="box">Box</option>
                      <option value="pallet">Pallet</option>
                      <option value="tube">Tube</option>
                      <option value="strip">Strip</option>
                      <option value="bulk">Bulk</option>
                    </select>
                  </div>
                </div>

                <div className="flex flex-col gap-1 bg-surface-container-high/40 p-2 rounded border border-outline-variant/40">
                  <span className="font-bold text-outline block mb-1">Exchange Conversion Reference</span>
                  <p className="text-[10px] text-outline-variant leading-relaxed">
                    Auto-fills values bidirectionally at ZAR to USD exchange rate <b>1 : 19.00</b>
                  </p>
                </div>

                <div className="flex flex-col gap-1">
                  <label className="font-bold text-outline">Short Description (optional)</label>
                  <input
                    name="description"
                    placeholder="e.g. 32-bit ARM Cortex M0 core with low power alerts"
                    className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none"
                    type="text"
                    value={newItem.description}
                    onChange={(e) => setNewItem({ ...newItem, description: e.target.value })}
                  />
                </div>

                <button
                  type="submit"
                  className="w-full bg-primary text-on-primary py-2.5 rounded font-extrabold shadow shadow-primary/25 hover:brightness-110 active:scale-95 transition-all text-center uppercase tracking-wide text-xs mt-sm"
                >
                  Register Component SKU
                </button>
              </form>
            </div>
          </div>
        )}

        {showImportModal && (
          <div className="fixed inset-0 bg-background/80 backdrop-blur-xs flex items-center justify-center z-100 p-md">
            <div className="bg-surface-container rounded-xl border border-outline-variant max-w-[512px] w-full p-lg shadow-2xl relative">
              <button
                onClick={() => {
                  setShowImportModal(false);
                  setCsvFileContent('');
                  setCsvParsedPreview([]);
                }}
                className="absolute top-sm right-sm text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high p-1.5 rounded-lg transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>

              <div className="flex items-center gap-xs text-primary mb-xs">
                <FileSpreadsheet className="w-4 h-4 shrink-0" />
                <span className="text-[10px] font-bold">CSV Data Administration</span>
              </div>
              <h4 className="font-headline-sm text-lg font-black text-primary block mb-md select-none tracking-tighter leading-none">
                Bulk Import SKU Inventory CSV File
              </h4>

              {csvParsedPreview.length === 0 ? (
                <div className="space-y-md text-xs">
                  {/* Drag-and-drop region */}
                  <div
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    className={`border-2 border-dashed rounded-xl p-lg flex flex-col items-center justify-center text-center transition-all min-h-50 cursor-pointer ${isDraggingCsv
                      ? 'border-primary bg-primary/10 scale-[1.02]'
                      : 'border-outline-variant bg-surface-container-high/40 hover:border-primary/50'
                      }`}
                  >
                    <label className="w-full h-full flex flex-col items-center justify-center cursor-pointer">
                      <input
                        type="file"
                        accept=".csv"
                        className="hidden"
                        onChange={handleFileChange}
                      />
                      <Upload className={`w-10 h-10 mb-sm text-outline ${isDraggingCsv ? 'animate-bounce text-primary' : ''}`} />
                      <span className="font-bold text-xs text-on-surface block mb-1">
                        Drag & Drop your maininventory.csv file here
                      </span>
                      <span className="text-[11px] text-on-surface-variant block mb-3">
                        or click to browse local files
                      </span>
                      <span className="text-[10px] bg-surface-container border border-outline-variant text-primary px-3 py-1.5 rounded font-mono font-bold hover:bg-surface-container-high transition-colors">
                        Choose CSV File
                      </span>
                    </label>
                  </div>

                  {/* Demo load option */}
                  <div className="bg-primary/5 border border-primary/20 rounded-lg p-sm flex items-center justify-between text-xs gap-sm">
                    <span className="text-on-surface-variant leading-tight">
                      No CSV file on hand? Import the default <b>maininventory.csv</b> data set directly.
                    </span>
                    <button
                      type="button"
                      onClick={loadDefaultCSV}
                      className="bg-primary text-on-primary font-bold text-[10px] uppercase tracking-wider px-md py-1.5 rounded shrink-0 hover:brightness-110 shadow-sm cursor-pointer transition-colors"
                    >
                      Load Stand-In
                    </button>
                  </div>

                  {/* CSV formatting helper */}
                  <div className="text-[10px] text-on-surface-variant space-y-1 bg-surface-container-low p-3 rounded border border-outline-variant/30">
                    <span className="font-bold uppercase tracking-wider block text-on-surface text-[9px] mb-1">Required CSV Columns Layout:</span>
                    <p className="font-mono bg-surface-container/60 p-1 rounded overflow-x-auto text-[9px] whitespace-nowrap text-on-surface">
                      serial_number; name; description; value; size; package; ...; stock; ...
                    </p>
                    <p className="leading-relaxed">
                      Accepts both Semicolon (<code className="font-mono text-primary font-bold">;</code>) and Comma (<code className="font-mono text-primary font-bold">,</code>) delimiters. Part numbers are used as unique reference SKU IDs.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-md">
                  {/* Success preview banner */}
                  <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-sm flex items-center gap-sm text-xs">
                    <Check className="w-5 h-5 text-green-400 shrink-0" />
                    <div>
                      <span className="font-semibold text-xs text-green-400 block leading-tight">Successfully Parsed CSV Elements</span>
                      <span className="text-[10px] text-outline">Detected {csvParsedPreview.length} unique component SKU item entries ready for ingest.</span>
                    </div>
                  </div>

                  {/* Preview sub-table */}
                  <div className="border border-outline-variant rounded-lg overflow-hidden bg-surface-container-high text-xs">
                    <div className="px-sm py-1.5 bg-surface-container-highest border-b border-outline-variant text-[10px] font-bold text-outline">
                      SKU Ingest Ledger Preview (Top 5 Rows)
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left font-mono text-[10px] text-on-surface">
                        <thead>
                          <tr className="bg-surface-container-low border-b border-outline-variant text-outline">
                            <th className="px-2 py-1">SKU ID</th>
                            <th className="px-2 py-1">Item Title</th>
                            <th className="px-2 py-1 text-right">Units</th>
                            <th className="px-2 py-1 text-right">Standard Cost</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-outline-variant/30">
                          {csvParsedPreview.slice(0, 5).map(item => (
                            <tr key={item.partNumber}>
                              <td className="px-2 py-1 font-bold text-primary">{item.partNumber}</td>
                              <td className="px-2 py-1 truncate max-w-[150px]">{item.name}</td>
                              <td className="px-2 py-1 text-right">{(item.stockLevel ?? 0).toLocaleString()}</td>
                              <td className="px-2 py-1 text-right">${item.price.toFixed(4)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {csvParsedPreview.length > 5 && (
                      <div className="px-sm py-1 bg-surface-container border-t border-outline-variant text-center font-mono text-[9px] text-outline">
                        &bull; &bull; &bull; and {csvParsedPreview.length - 5} more elements parsed &bull; &bull; &bull;
                      </div>
                    )}
                  </div>

                  {/* Commit Action Buttons */}
                  <div className="grid grid-cols-2 gap-sm pt-sm text-xs">
                    <button
                      type="button"
                      onClick={() => {
                        setCsvFileContent('');
                        setCsvParsedPreview([]);
                      }}
                      className="border border-outline-variant hover:bg-surface-container-high py-2 rounded font-bold transition-all text-center text-xs cursor-pointer text-on-surface"
                    >
                      Reset File Selection
                    </button>
                    <button
                      type="button"
                      onClick={handleApplyImport}
                      className="bg-primary text-on-primary py-2 rounded font-extrabold shadow shadow-primary/25 hover:brightness-110 active:scale-95 transition-all text-center flex items-center justify-center gap-1.5 text-xs cursor-pointer uppercase tracking-wider"
                    >
                      <Check className="w-4 h-4" /> Apply SKU ledger
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {showBookInModal && (
          <div className="fixed inset-0 bg-background/80 backdrop-blur-xs flex items-center justify-center z-100 p-md">
            <div className="bg-surface-container rounded-xl border border-outline-variant max-w-[448px] w-full p-lg shadow-2xl relative">
              <button
                onClick={() => setShowBookInModal(false)} aria-label="Close modal"
                className="absolute top-sm right-sm text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high p-1.5 rounded-lg transition-colors"
                type="button"
              >
                <X className="w-4 h-4" />
              </button>

              <div className="flex items-center gap-xs text-secondary mb-xs">
                <RefreshCw className="w-4 h-4 shrink-0 text-primary" />
                <span className="text-[10px] font-bold">Warehouse Operations Portal</span>
              </div>
              <h4 className="font-headline-sm text-lg font-black text-primary block mb-md select-none tracking-tighter leading-none">
                Replenish Inventory (Book-In Component)
              </h4>

              <form onSubmit={handleBookInItem} className="space-y-sm text-xs">
                {/* Select Dropdown for Stock code */}
                <div className="flex flex-col gap-1">
                  <label className="font-bold text-outline">Stock Code (SKU Core Reference)</label>
                  <select aria-label="Filter"
                    className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary font-mono text-xs uppercase"
                    required
                    value={bookInPartNumber}
                    onChange={(e) => {
                      const val = e.target.value;
                      setBookInPartNumber(val);
                      // Pull current properties
                      const selectedItem = items.find(i => i.partNumber === val);
                      if (selectedItem) {
                        setBookInDescription(selectedItem.description);
                        setBookInCost(selectedItem.price);
                        setBookInDiscontinued(selectedItem.status === 'DISCONTINUED');
                      }
                    }}
                  >
                    <option value="" disabled>-- Choose Component --</option>
                    {items.map(i => (
                      <option key={i.partNumber} value={i.partNumber}>
                        {i.partNumber} &bull; {i.name} (Stock: {i.stockLevel})
                      </option>
                    ))}
                  </select>
                </div>

                {/* Edit description on fly */}
                <div className="flex flex-col gap-1">
                  <label className="font-bold text-outline">Component Description</label>
                  <textarea
                    rows={2}
                    placeholder="e.g. 10uF 50V Capacitor"
                    className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary px-2 py-1 focus:ring-0 text-xs leading-normal font-sans"
                    required
                    value={bookInDescription}
                    onChange={(e) => setBookInDescription(e.target.value)}
                  />
                </div>

                <div className="grid grid-cols-2 gap-sm">
                  {/* Cost prompt */}
                  <div className="flex flex-col gap-1">
                    <label className="font-bold text-outline">New Component Cost ($)</label>
                    <input
                      className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none font-mono text-xs focus:border-primary"
                      type="number"
                      step="0.001"
                      min="0.001"
                      required
                      value={bookInCost}
                      onChange={(e) => setBookInCost(Number(e.target.value) || 0)}
                    />
                  </div>

                  {/* Quantity change */}
                  <div className="flex flex-col gap-1">
                    <label className="font-bold text-outline">Qty Change (To Add)</label>
                    <input
                      className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none font-mono text-xs focus:border-primary"
                      type="number"
                      min="1"
                      required
                      value={bookInQty}
                      onChange={(e) => setBookInQty(Number(e.target.value) || 0)}
                    />
                  </div>
                </div>

                {/* Update Standard Cost toggle */}
                <div className="p-sm rounded bg-surface-container-high/60 border border-outline-variant/60 flex items-center justify-between select-none p-2">
                  <div>
                    <span className="font-bold text-xs block text-on-surface">Update item standard cost?</span>
                    <span className="text-[10px] text-outline">Overwrites general SKU pricing profile</span>
                  </div>
                  <input
                    type="checkbox"
                    className="w-4 h-4 text-primary bg-surface border-outline-variant rounded outline-none focus:ring-0 cursor-pointer"
                    checked={bookInUpdateStandardCost}
                    onChange={(e) => setBookInUpdateStandardCost(e.target.checked)}
                  />
                </div>

                {/* Discontinued toggle */}
                <div className="p-sm rounded bg-surface-container-high/60 border border-outline-variant/60 flex items-center justify-between select-none p-2">
                  <div>
                    <span className="font-bold text-xs block text-on-surface">Discontinued Component?</span>
                    <span className="text-[10px] text-outline">Mark as flagged or out of service</span>
                  </div>
                  <input
                    type="checkbox"
                    className="w-4 h-4 text-primary bg-surface border-outline-variant rounded outline-none focus:ring-0 cursor-pointer"
                    checked={bookInDiscontinued}
                    onChange={(e) => setBookInDiscontinued(e.target.checked)}
                  />
                </div>

                <button
                  type="submit"
                  className="w-full bg-secondary text-white py-2.5 rounded font-extrabold shadow hover:brightness-110 active:scale-95 transition-all text-center uppercase tracking-wide text-xs mt-sm"
                >
                  Book In Component Stock
                </button>
              </form>
            </div>
          </div>
        )}

        {/* Supplier Management Modal */}
        {showSupplierModal && (
          <div className="fixed inset-0 bg-background/80 backdrop-blur-xs flex items-center justify-center z-100 p-md">
            <div className="bg-surface-container rounded-xl border border-outline-variant max-w-[448px] w-full p-lg shadow-2xl relative">
              <button
                onClick={() => setShowSupplierModal(false)} aria-label="Close modal"
                className="absolute top-sm right-sm text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high p-1.5 rounded-lg transition-colors"
              >
                <X className="w-4 h-4" />
              </button>

              <h4 className="font-headline-sm text-lg font-black text-primary block mb-md select-none tracking-tighter leading-none">
                {editingSupplier ? 'Edit Procurement Partner' : 'Register New Procurement Partner'}
              </h4>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  const nextId = editingSupplier?.id || String(Math.max(...suppliers.map(s => parseInt(s.id) || 0), 0) + 1);
                  const supplier: Supplier = {
                    id: nextId,
                    name: fd.get('name') as string,
                    website: fd.get('website') as string,
                    contact_email: fd.get('contact_email') as string,
                    notes: fd.get('notes') as string,
                    leadTime: parseInt(fd.get('lead_time') as string) || 0,
                    responseTime: parseInt(fd.get('response_time') as string) || 0,
                  };
                  handleSaveSupplier(supplier);
                }}
                className="space-y-sm text-xs"
              >
                <div className="flex flex-col gap-1">
                  <label className="font-bold text-outline">Supplier ID</label>
                  <input
                    name="id"
                    className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none font-mono text-xs opacity-60 cursor-not-allowed"
                    type="text"
                    disabled
                    value={editingSupplier?.id || String(Math.max(...suppliers.map(s => parseInt(s.id) || 0), 0) + 1)}
                    readOnly
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label className="font-bold text-outline">Supplier Entity Name</label>
                  <input
                    name="name"
                    placeholder="e.g. Mouser Electronics"
                    className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary font-semibold text-xs"
                    type="text"
                    required
                    defaultValue={editingSupplier?.name || ''}
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label className="font-bold text-outline">Official Website (URL)</label>
                  <input
                    name="website"
                    placeholder="https://..."
                    className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary font-mono text-xs"
                    type="url"
                    required
                    defaultValue={editingSupplier?.website || ''}
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label className="font-bold text-outline">Contact Email Specifications</label>
                  <input
                    name="contact_email"
                    placeholder="sales@supplier.com"
                    className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary font-mono text-xs"
                    type="email"
                    defaultValue={editingSupplier?.contact_email || ''}
                  />
                </div>

                <div className="grid grid-cols-2 gap-sm">
                  <div className="flex flex-col gap-1">
                    <label className="font-bold text-outline">Avg Lead Time (Days)</label>
                    <input
                      name="lead_time"
                      placeholder="e.g. 5"
                      className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary font-mono text-xs"
                      type="number"
                      min="0"
                      defaultValue={editingSupplier?.leadTime || ''}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="font-bold text-outline">Avg Response (Hrs)</label>
                    <input
                      name="response_time"
                      placeholder="e.g. 2"
                      className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary font-mono text-xs"
                      type="number"
                      min="0"
                      defaultValue={editingSupplier?.responseTime || ''}
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1">
                  <label className="font-bold text-outline">Notes & Administrative Parameters</label>
                  <textarea
                    name="notes"
                    rows={3}
                    placeholder="e.g. Primary PCB manufacturer for EMEA region..."
                    className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary font-sans text-xs"
                    defaultValue={editingSupplier?.notes || ''}
                  />
                </div>

                <button
                  type="submit"
                  className="w-full bg-primary text-on-primary py-2.5 rounded font-extrabold shadow shadow-primary/25 hover:brightness-110 active:scale-95 transition-all text-center uppercase tracking-wide text-xs mt-sm"
                >
                  {editingSupplier ? 'Update Supplier Data' : 'Register Supplier Partner'}
                </button>
              </form>
            </div>
          </div>
        )}

        {/* Item Detail & Editing Modal */}
        {selectedDetailPartNumber && detailItem && (
          <ItemDetailModal
            item={detailItem}
            onClose={() => setSelectedDetailPartNumber(null)}
            onSave={handleSaveItemDetail}
          />
        )}

        {/* ========================================================================= */}
        {/* NEW PRODUCTION KITS PROVISIONING MODAL OVERLAY */}
        {/* ========================================================================= */}
        {isKitModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-fade-in">
            <div className="w-full max-w-[896px] max-h-[90vh] overflow-y-auto bg-surface-container border border-outline-variant rounded-xl shadow-2xl relative">

              {/* Close Button Anchor Trigger */}
              <button
                onClick={() => setIsKitModalOpen(false)} aria-label="Close modal"
                className="absolute top-4 right-4 p-1.5 rounded-lg text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface transition-colors cursor-pointer z-10"
              >
                <X className="w-4 h-4" />
              </button>

              <div className="p-2">
                <ProductionKitsManager
                  onKitCreated={handleNewKitCreation}
                  onBatchKitsUploaded={(uploadedKits) => {
                    setProductionKits((prev) => [...uploadedKits, ...prev]);
                    setIsKitModalOpen(false); // Close modal automatically on file read parse success
                  }}
                  triggerToast={triggerToast}
                  projects={projects}
                  editingKit={editingKit}
                  onCancelEdit={() => {
                    setEditingKit(null);
                    setIsKitModalOpen(false);
                  }}
                />
              </div>

            </div>
          </div>
        )}

      </main>
    </div>
  );
}
