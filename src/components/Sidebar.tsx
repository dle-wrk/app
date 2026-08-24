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
  ChevronDown,
  Activity,
  BookOpen,
  PanelLeftClose,
  PanelLeftOpen
} from 'lucide-react';
import { ViewType, UserProfile } from '../types';

interface SidebarProps {
  currentView: ViewType;
  setView: (view: ViewType) => void;
  appName: string;
  isSidebarOpen: boolean;
  setIsSidebarOpen: (open: boolean) => void;
  profile: UserProfile;
  /** Desktop-only rail mode: icons only, no labels, no section headers. On
   * mobile the drawer always shows the full labels regardless of this flag. */
  isCollapsed: boolean;
  setIsCollapsed: (collapsed: boolean) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentView,
  setView,
  appName,
  isSidebarOpen,
  setIsSidebarOpen,
  profile,
  isCollapsed,
  setIsCollapsed,
}) => {
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    main: true,
    stock: false,
    manufacturing: false,
    projects: false,
    automation: false,
    quality: false,
    documentation: false,
    admin: false,
  });

  // In collapsed rail mode every section header is hidden, so users can't
  // toggle them. Force every section open so all icons stay reachable.
  const effectiveExpanded = isCollapsed
    ? { main: true, stock: true, manufacturing: true, projects: true, automation: true, quality: true, documentation: true, admin: true }
    : expandedSections;

  const toggleSection = (section: string) => {
    setExpandedSections((prev): Record<string, boolean> => {
      const isCurrentlyOpen = prev[section];
      // Manufacturing is a sub-toggle nested within Projects — toggle independently
      if (section === 'manufacturing') {
        return { ...prev, manufacturing: !isCurrentlyOpen };
      }
      // Main sections: close all others, open the clicked one
      return {
        main: true,
        stock: section === 'stock' && !isCurrentlyOpen,
        projects: section === 'projects' && !isCurrentlyOpen,
        manufacturing: false,
        automation: section === 'automation' && !isCurrentlyOpen,
        quality: section === 'quality' && !isCurrentlyOpen,
        documentation: section === 'documentation' && !isCurrentlyOpen,
        admin: section === 'admin' && !isCurrentlyOpen,
      };
    });
  };
  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'stock_kits', label: 'Stock Tables', icon: TableProperties },
    { id: 'pricing', label: 'Pricing Directory', icon: Tag },
    { id: 'suppliers', label: 'Suppliers', icon: Factory },
    { id: 'bookkeeping', label: 'Bookkeeping', icon: Receipt },
  ] as const;

  const stockItems = [
    { id: 'items', label: 'Items & Inventory', icon: Boxes },
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
    <aside
      data-collapsed={isCollapsed ? 'true' : 'false'}
      className={`sidebar-rail fixed min-h-dvh left-0 top-0 bg-(--sidebar-bg) border-r border-outline-variant flex flex-col z-50 transition-[width,transform] duration-300 shadow-2xl lg:translate-x-0 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'} w-64 ${isCollapsed ? 'lg:w-14' : 'lg:w-64'}`}
    >
      <div className={`mb-xl flex flex-col pt-sm relative py-md shrink-0 ${isCollapsed ? 'lg:px-1 lg:items-center px-md' : 'px-md'}`}>
        <button
          onClick={() => setIsSidebarOpen(false)}
          className="lg:hidden absolute top-0 right-2 p-2 text-on-surface-variant hover:text-on-surface"
        >
          <X className="w-5 h-5" aria-label="Close" />
        </button>
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="hidden lg:flex absolute top-1 right-1 p-1.5 text-on-surface-variant hover:text-on-surface hover:bg-surface-variant/40 rounded"
        >
          {isCollapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
        </button>
        <div className="flex items-center gap-xs mb-1">
          <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center shadow-lg shadow-primary/20 shrink-0">
            <Workflow className="text-white w-5 h-5" />
          </div>
          <span className={`text-primary font-black text-[22px] tracking-tighter ${isCollapsed ? 'lg:hidden' : ''}`}>{appName}</span>
        </div>
        <div className={`flex items-center gap-2 ${isCollapsed ? 'lg:hidden' : ''}`}>
          <span className="text-[10px] bg-primary/10 border border-primary/20 text-primary px-1.5 py-0.5 rounded-full font-black">
            v{__APP_VERSION__}-PRO
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
            title={isCollapsed ? item.label : undefined}
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
          onClick={() => toggleSection('stock')}
          className="rail-section-header w-full flex items-center justify-between px-2.5 py-1.5 mt-3 text-[10px] text-outline font-bold opacity-60 hover:opacity-100 transition-opacity"
        >
          <span>STOCK</span>
          <ChevronDown className={`w-3 h-3 transition-transform ${expandedSections.stock ? '' : '-rotate-90'}`} />
        </button>
        {effectiveExpanded.stock && stockItems.map((item) => (
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
          className="rail-section-header w-full flex items-center justify-between px-2.5 py-1.5 mt-3 text-[10px] text-outline font-bold opacity-60 hover:opacity-100 transition-opacity"
        >
          <span>PROJECTS</span>
          <ChevronDown className={`w-3 h-3 transition-transform ${expandedSections.projects ? '' : '-rotate-90'}`} />
        </button>
        {effectiveExpanded.projects && (
          <>
            {projectItems.map((item) => (
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
              onClick={() => toggleSection('manufacturing')}
              className="rail-section-header w-full flex items-center justify-between pl-5 pr-2.5 py-1.5 mt-1 text-[10px] text-outline font-bold opacity-60 hover:opacity-100 transition-opacity"
            >
              <span>MANUFACTURING</span>
              <ChevronDown className={`w-3 h-3 transition-transform ${expandedSections.manufacturing ? '' : '-rotate-90'}`} />
            </button>
            {effectiveExpanded.manufacturing && manufacturingItems.map((item) => (
              <button
                key={item.id}
                onClick={() => handleNavClick(item.id as ViewType)}
                className={`w-full flex items-center pl-7 pr-2.5 py-1.5 rounded text-left transition-all text-[12px] ${currentView === item.id
                  ? 'text-primary font-bold border-l-4 border-primary bg-primary/10'
                  : 'text-on-surface-variant/80 hover:text-on-surface hover:bg-surface-variant/40'
                  }`}
              >
                <item.icon className="w-3.5 h-3.5 mr-2" />
                <span>{item.label}</span>
              </button>
            ))}
          </>
        )}

        <button
          onClick={() => toggleSection('automation')}
          className="rail-section-header w-full flex items-center justify-between px-2.5 py-1.5 mt-3 text-[10px] text-outline font-bold opacity-60 hover:opacity-100 transition-opacity"
        >
          <span>AUTOMATION</span>
          <ChevronDown className={`w-3 h-3 transition-transform ${expandedSections.automation ? '' : '-rotate-90'}`} />
        </button>
        {effectiveExpanded.automation && automationItems.map((item) => (
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
          className="rail-section-header w-full flex items-center justify-between px-2.5 py-1.5 mt-3 text-[10px] text-outline font-bold opacity-60 hover:opacity-100 transition-opacity"
        >
          <span>QUALITY</span>
          <ChevronDown className={`w-3 h-3 transition-transform ${expandedSections.quality ? '' : '-rotate-90'}`} />
        </button>
        {effectiveExpanded.quality && phase5Items.map((item) => (
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
          onClick={() => toggleSection('documentation')}
          className="rail-section-header w-full flex items-center justify-between px-2.5 py-1.5 mt-3 text-[10px] text-outline font-bold opacity-60 hover:opacity-100 transition-opacity"
        >
          <span>DOCUMENTATION</span>
          <ChevronDown className={`w-3 h-3 transition-transform ${expandedSections.documentation ? '' : '-rotate-90'}`} />
        </button>
        {effectiveExpanded.documentation && (
          <button
            onClick={() => handleNavClick('documentation' as ViewType)}
            title={isCollapsed ? 'Documentation' : undefined}
            className={`w-full flex items-center px-2.5 py-1.5 rounded text-left transition-all text-[12px] ${
              currentView === 'documentation'
                ? 'text-primary font-bold border-l-4 border-primary bg-primary/10'
                : 'text-on-surface-variant/80 hover:text-on-surface hover:bg-surface-variant/40'
            }`}
          >
            <BookOpen className="w-3.5 h-3.5 mr-2" />
            <span>Docs & Guides</span>
          </button>
        )}

        <button
          onClick={() => toggleSection('admin')}
          className="rail-section-header w-full flex items-center justify-between px-2.5 py-1.5 mt-3 text-[10px] text-outline font-bold opacity-60 hover:opacity-100 transition-opacity"
        >
          <span>ADMIN</span>
          <ChevronDown className={`w-3 h-3 transition-transform ${expandedSections.admin ? '' : '-rotate-90'}`} />
        </button>
        {effectiveExpanded.admin && (
          <>
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

            <button
              onClick={() => handleNavClick('activity-logs')}
              className={`w-full flex items-center px-2.5 py-1.5 rounded text-left transition-all text-[12px] ${currentView === 'activity-logs'
                ? 'text-primary font-bold border-l-4 border-primary bg-primary/10'
                : 'text-on-surface-variant/80 hover:text-on-surface hover:bg-surface-variant/40'
                }`}
            >
              <Activity className="w-3.5 h-3.5 mr-2" />
              <span>Activity Logs</span>
            </button>

            <button
              onClick={() => handleNavClick('reports_ledger')}
              className={`w-full flex items-center px-2.5 py-1.5 rounded text-left transition-all text-[12px] ${currentView === 'reports_ledger'
                ? 'text-primary font-bold border-l-4 border-primary bg-primary/10'
                : 'text-on-surface-variant/80 hover:text-on-surface hover:bg-surface-variant/40'
                }`}
            >
              <ArrowLeftRight className="w-3.5 h-3.5 mr-2" />
              <span>Reports & Ledger</span>
            </button>
          </>
        )}
      </nav>

      <div className={`mt-auto px-sm pt-md border-t border-outline-variant/30 space-y-md ${isCollapsed ? 'lg:px-0' : ''}`}>
        <div className={`mx-md p-sm rounded bg-surface-container-high/40 flex items-center gap-xs font-mono text-[10px] text-on-surface-variant ${isCollapsed ? 'lg:hidden' : ''}`}>
          <span className="w-2 h-2 rounded-full bg-green-500 inline-block"></span>
          <span className="rail-footer-label">DB Node: active_sync</span>
        </div>

        <div
          onClick={() => handleNavClick('profile')}
          title={isCollapsed ? profile.name : undefined}
          className={`flex items-center px-md py-sm rounded hover:bg-surface-variant/40 cursor-pointer transition-all duration-200 ${isCollapsed ? 'lg:justify-center lg:px-0' : ''}`}
        >
          <div className={`w-8 h-8 rounded-full overflow-hidden border border-outline-variant shrink-0 relative ${isCollapsed ? 'lg:mr-0 mr-sm' : 'mr-sm'}`}>
            <img
              className="w-full h-full object-cover"
              src={profile.avatarUrl}
              alt={`${profile.name} Profile`}
            />
          </div>
          <div className={`truncate flex flex-col justify-center rail-footer-label ${isCollapsed ? 'lg:hidden' : ''}`}>
            <span className="font-body-md text-xs font-bold leading-tight truncate">{profile.name}</span>
            <span className="text-[10px] text-outline truncate">{profile.role}</span>
          </div>
        </div>
      </div>
    </aside>
  );
};