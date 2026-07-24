import React, { useState } from 'react';
import {
  LayoutDashboard,
  Boxes,
  Database,
  ArrowLeftRight,
  Settings,
  Tag,
  Receipt,
  Factory,
  TableProperties,
  HelpCircle,
  X,
  Workflow,
  ClipboardList,
  Calculator,
  Zap,
  Brain,
  Shield,
  ChevronDown
} from 'lucide-react';
import { ViewType, UserProfile } from '../types';

interface SidebarProps {
  currentView: ViewType;
  setView: (view: ViewType) => void;
  appName: string;
  isSidebarOpen: boolean;
  setIsSidebarOpen: (open: boolean) => void;
  profile: UserProfile;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentView,
  setView,
  appName,
  isSidebarOpen,
  setIsSidebarOpen,
  profile
}) => {
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    main: true,
    manufacturing: false,
    projects: false,
    automation: false,
    quality: false,
  });

  const toggleSection = (section: string) => {
    setExpandedSections(prev => {
      const isCurrentlyOpen = prev[section];
      return {
        main: true,
        manufacturing: section === 'manufacturing' && !isCurrentlyOpen,
        projects: section === 'projects' && !isCurrentlyOpen,
        automation: section === 'automation' && !isCurrentlyOpen,
        quality: section === 'quality' && !isCurrentlyOpen,
      };
    });
  };
  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'items', label: 'Items & Inventory', icon: Boxes },
    { id: 'stock_kits', label: 'Stock Tables', icon: TableProperties },
    { id: 'reports_ledger', label: 'Reports & Ledger', icon: ArrowLeftRight },
    { id: 'pricing', label: 'Pricing Directory', icon: Tag },
    { id: 'suppliers', label: 'Suppliers', icon: Factory },
    { id: 'bookkeeping', label: 'Bookkeeping', icon: Receipt },
    { id: 'production_costs', label: 'Production Costs', icon: Calculator },
  ] as const;

  const manufacturingItems = [
    { id: 'kit_booking', label: 'P&P Kit Booking', icon: Boxes },
    { id: 'bom_manager', label: 'Bill of Materials', icon: Boxes },
    { id: 'pick_place', label: 'Pick & Place', icon: Database },
    { id: 'alternates', label: 'Component Alternates', icon: ArrowLeftRight },
  ] as const;

  const projectItems = [
    { id: 'projects', label: 'Project Manager', icon: ClipboardList },
  ] as const;

  const automationItems = [
    { id: 'automation', label: 'Automation Dashboard', icon: Zap },
    { id: 'auto_po_config', label: 'Auto-PO Config', icon: Settings },
  ] as const;

  const phase5Items = [
    { id: 'quality_compliance', label: 'Quality & Compliance', icon: Shield },
    { id: 'advanced_automation', label: 'Advanced Automation', icon: Brain },
  ] as const;

  const handleNavClick = (view: ViewType) => {
    setView(view);
    setIsSidebarOpen(false);
  };

  return (
    <aside className={`fixed min-h-dvh w-64 left-0 top-0 bg-(--sidebar-bg) border-r border-outline-variant flex flex-col z-50 transition-all duration-300 shadow-2xl lg:translate-x-0 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
      <div className="px-md mb-xl flex flex-col pt-sm relative py-md shrink-0">
        <button
          onClick={() => setIsSidebarOpen(false)}
          className="lg:hidden absolute top-0 right-2 p-2 text-on-surface-variant hover:text-on-surface"
        >
          <X className="w-5 h-5" aria-label="Close" />
        </button>
        <div className="flex items-center gap-xs mb-1">
          <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center shadow-lg shadow-primary/20">
            <Workflow className="text-white w-5 h-5" />
          </div>
          <span className="text-primary font-black text-[22px] tracking-tighter">{appName}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] bg-primary/10 border border-primary/20 text-primary px-1.5 py-0.5 rounded-full font-black">
            v2.5.0-PRO
          </span>
          <span className="text-[10px] text-[#8c909f] font-bold">
            Data Captuiring
          </span>
        </div>
      </div>

      <nav className="flex-1 space-y-0.5 px-2 overflow-y-auto custom-scrollbar min-h-0">
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => handleNavClick(item.id as ViewType)}
            className={`w-full flex items-center px-2.5 py-2 rounded-lg text-left transition-all group ${currentView === item.id
              ? 'text-primary font-black bg-primary/10 shadow-sm ring-1 ring-primary/20'
              : 'text-on-surface-variant/70 hover:text-on-surface hover:bg-surface-variant/40'
              }`}
          >
            <item.icon className={`w-4 h-4 mr-2.5 transition-transform group-hover:scale-110 ${currentView === item.id ? 'text-primary' : 'text-on-surface-variant/50'}`} />
            <span className="text-[12px] tracking-tight">{item.label}</span>
          </button>
        ))}

        <button
          onClick={() => toggleSection('manufacturing')}
          className="w-full flex items-center justify-between px-2.5 py-1.5 mt-3 text-[10px] text-outline font-bold opacity-60 hover:opacity-100 transition-opacity"
        >
          <span>MANUFACTURING</span>
          <ChevronDown className={`w-3 h-3 transition-transform ${expandedSections.manufacturing ? '' : '-rotate-90'}`} />
        </button>
        {expandedSections.manufacturing && manufacturingItems.map((item) => (
          <button
            key={item.id}
            onClick={() => handleNavClick(item.id as ViewType)}
            className={`w-full flex items-center px-2.5 py-1.5 rounded text-left transition-all text-[12px] ${currentView === item.id
              ? 'text-primary font-bold border-l-4 border-primary bg-primary/10'
              : 'text-on-surface-variant/80 hover:text-on-surface hover:bg-surface-variant/40'
              }`}
          >
            <item.icon className="w-3.5 h-3.5 mr-2" />
            <span>{item.label}</span>
          </button>
        ))}

        <button
          onClick={() => toggleSection('projects')}
          className="w-full flex items-center justify-between px-2.5 py-1.5 mt-3 text-[10px] text-outline font-bold opacity-60 hover:opacity-100 transition-opacity"
        >
          <span>PROJECTS</span>
          <ChevronDown className={`w-3 h-3 transition-transform ${expandedSections.projects ? '' : '-rotate-90'}`} />
        </button>
        {expandedSections.projects && projectItems.map((item) => (
          <button
            key={item.id}
            onClick={() => handleNavClick(item.id as ViewType)}
            className={`w-full flex items-center px-2.5 py-1.5 rounded text-left transition-all text-[12px] ${currentView === item.id
              ? 'text-primary font-bold border-l-4 border-primary bg-primary/10'
              : 'text-on-surface-variant/80 hover:text-on-surface hover:bg-surface-variant/40'
              }`}
          >
            <item.icon className="w-3.5 h-3.5 mr-2" />
            <span>{item.label}</span>
          </button>
        ))}

        <button
          onClick={() => toggleSection('automation')}
          className="w-full flex items-center justify-between px-2.5 py-1.5 mt-3 text-[10px] text-outline font-bold opacity-60 hover:opacity-100 transition-opacity"
        >
          <span>AUTOMATION</span>
          <ChevronDown className={`w-3 h-3 transition-transform ${expandedSections.automation ? '' : '-rotate-90'}`} />
        </button>
        {expandedSections.automation && automationItems.map((item) => (
          <button
            key={item.id}
            onClick={() => handleNavClick(item.id as ViewType)}
            className={`w-full flex items-center px-2.5 py-1.5 rounded text-left transition-all text-[12px] ${currentView === item.id
              ? 'text-primary font-bold border-l-4 border-primary bg-primary/10'
              : 'text-on-surface-variant/80 hover:text-on-surface hover:bg-surface-variant/40'
              }`}
          >
            <item.icon className="w-3.5 h-3.5 mr-2" />
            <span>{item.label}</span>
          </button>
        ))}

        <button
          onClick={() => toggleSection('quality')}
          className="w-full flex items-center justify-between px-2.5 py-1.5 mt-3 text-[10px] text-outline font-bold opacity-60 hover:opacity-100 transition-opacity"
        >
          <span>QUALITY</span>
          <ChevronDown className={`w-3 h-3 transition-transform ${expandedSections.quality ? '' : '-rotate-90'}`} />
        </button>
        {expandedSections.quality && phase5Items.map((item) => (
          <button
            key={item.id}
            onClick={() => handleNavClick(item.id as ViewType)}
            className={`w-full flex items-center px-2.5 py-1.5 rounded text-left transition-all text-[12px] ${currentView === item.id
              ? 'text-primary font-bold border-l-4 border-primary bg-primary/10'
              : 'text-on-surface-variant/80 hover:text-on-surface hover:bg-surface-variant/40'
              }`}
          >
            <item.icon className="w-3.5 h-3.5 mr-2" />
            <span>{item.label}</span>
          </button>
        ))}

        <div className="pt-3 px-2.5 mb-1 text-[10px] text-outline font-bold opacity-40">
          ADMIN
        </div>

        <button
          onClick={() => handleNavClick('settings')}
          className={`w-full flex items-center px-2.5 py-1.5 rounded text-left transition-all text-[12px] ${currentView === 'settings'
            ? 'text-primary font-bold border-l-4 border-primary bg-primary/10'
            : 'text-on-surface-variant/80 hover:text-on-surface hover:bg-surface-variant/40'
            }`}
        >
          <Settings className="w-3.5 h-3.5 mr-2" />
          <span>System Config</span>
        </button>
      </nav>

      <div className="mt-auto px-sm pt-md border-t border-outline-variant/30 space-y-md">
        <div className="mx-md p-sm rounded bg-surface-container-high/40 flex items-center gap-xs font-mono text-[10px] text-on-surface-variant">
          <span className="w-2 h-2 rounded-full bg-green-500 inline-block"></span>
          <span>DB Node: active_sync</span>
        </div>

        <div
          onClick={() => handleNavClick('profile')}
          className="flex items-center px-md py-sm rounded hover:bg-surface-variant/40 cursor-pointer transition-all duration-200"
        >
          <div className="w-8 h-8 rounded-full overflow-hidden mr-sm border border-outline-variant shrink-0 relative">
            <img
              className="w-full h-full object-cover"
              src={profile.avatarUrl}
              alt={`${profile.name} Profile`}
            />
          </div>
          <div className="truncate flex flex-col justify-center">
            <span className="font-body-md text-xs font-bold leading-tight truncate">{profile.name}</span>
            <span className="text-[10px] text-outline truncate">{profile.role}</span>
          </div>
        </div>
      </div>
    </aside>
  );
};