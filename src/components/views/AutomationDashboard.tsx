import React, { useState, useEffect } from 'react';
import {
  Zap, Clock, Bell, Settings, LogIn, AlertCircle, CheckCircle2,
  Play, Pause, RefreshCw, Plus, ChevronRight, TrendingUp
} from 'lucide-react';

interface AutomationStats {
  activeRules: number;
  scheduledJobs: number;
  pendingNotifications: number;
  eventCount: number;
  autoPOsCreated: number;
}

interface DashboardProps {
  triggerToast: (msg: string, type?: string) => void;
}

export default function AutomationDashboard({ triggerToast }: DashboardProps) {
  const [stats, setStats] = useState<AutomationStats>({
    activeRules: 0,
    scheduledJobs: 0,
    pendingNotifications: 0,
    eventCount: 0,
    autoPOsCreated: 0,
  });
  const [loading, setLoading] = useState(true);
  const [selectedView, setSelectedView] = useState<string>('overview');

  useEffect(() => {
    fetchStats();
  }, []);

  const fetchStats = async () => {
    setLoading(true);
    try {
      const [rules, jobs, notifs, events] = await Promise.all([
        fetch('/api/automation-rules?isActive=true').then(r => r.json()),
        fetch('/api/scheduled-jobs?isActive=true').then(r => r.json()),
        fetch('/api/notifications?status=PENDING').then(r => r.json()),
        fetch('/api/event-log?limit=100').then(r => r.json()),
      ]);

      setStats({
        activeRules: rules.length || 0,
        scheduledJobs: jobs.length || 0,
        pendingNotifications: notifs.length || 0,
        eventCount: events.length || 0,
        autoPOsCreated: events.filter((e: any) => e.event_type === 'AUTO_PO_CREATED').length || 0,
      });
    } catch (err: any) {
      triggerToast('Failed to load automation stats', 'ERROR');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-container-margin space-y-lg max-w-[1600px] mx-auto w-full select-none">
      {/* Header */}
      <div className="bg-surface-container border border-outline-variant p-lg rounded-xl flex flex-wrap lg:items-center justify-between gap-md">
        <div className="space-y-1 flex-1 min-w-[300px]">
          <div className="flex items-center gap-xs text-primary">
            <Zap className="w-5 h-5" />
            <span className="font-label-caps text-[10px] uppercase font-bold tracking-wider">System Automation</span>
          </div>
          <h3 className="font-headline-sm text-lg font-black text-on-surface">Workflow Automation & Events</h3>
          <p className="text-on-surface-variant text-xs max-w-[576px]">
            Monitor and manage automated workflows, scheduled jobs, notifications, and system events.
          </p>
        </div>
        <button
          onClick={fetchStats}
          className="h-9 px-lg rounded-lg flex items-center gap-xs text-xs font-bold uppercase tracking-wider transition-all bg-primary text-on-primary hover:brightness-110 active:scale-95"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-md">
        <StatCard
          icon={<Zap className="w-5 h-5" />}
          label="Active Rules"
          value={stats.activeRules}
          color="text-blue-400"
        />
        <StatCard
          icon={<Clock className="w-5 h-5" />}
          label="Scheduled Jobs"
          value={stats.scheduledJobs}
          color="text-cyan-400"
        />
        <StatCard
          icon={<Bell className="w-5 h-5" />}
          label="Pending Notifications"
          value={stats.pendingNotifications}
          color="text-yellow-400"
        />
        <StatCard
          icon={<TrendingUp className="w-5 h-5" />}
          label="Auto-POs Created"
          value={stats.autoPOsCreated}
          color="text-green-400"
        />
        <StatCard
          icon={<LogIn className="w-5 h-5" />}
          label="Recent Events"
          value={stats.eventCount}
          color="text-purple-400"
        />
      </div>

      {/* Navigation Tabs */}
      <div className="bg-surface-container-high/40 rounded-lg p-1 flex gap-1 overflow-x-auto">
        {[
          { id: 'overview', label: 'Overview', icon: Zap },
          { id: 'rules', label: 'Automation Rules', icon: Settings },
          { id: 'jobs', label: 'Scheduled Jobs', icon: Clock },
          { id: 'notifications', label: 'Notifications', icon: Bell },
          { id: 'auto-po', label: 'Auto-PO Config', icon: AlertCircle },
          { id: 'events', label: 'Event Log', icon: LogIn },
        ].map(tab => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setSelectedView(tab.id)}
              className={`px-4 py-2 rounded-lg text-xs font-bold whitespace-nowrap transition-all flex items-center gap-1 ${
                selectedView === tab.id
                  ? 'bg-primary text-on-primary'
                  : 'text-on-surface-variant hover:text-on-surface'
              }`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Content Area */}
      <div className="min-h-[400px]">
        {selectedView === 'overview' && <OverviewSection stats={stats} onNavigate={setSelectedView} />}
        {selectedView === 'rules' && <AutomationRulesSection triggerToast={triggerToast} />}
        {selectedView === 'jobs' && <ScheduledJobsSection triggerToast={triggerToast} />}
        {selectedView === 'notifications' && <NotificationsSection triggerToast={triggerToast} />}
        {selectedView === 'auto-po' && <AutoPOConfigSection triggerToast={triggerToast} />}
        {selectedView === 'events' && <EventLogSection triggerToast={triggerToast} />}
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, color }: any) {
  return (
    <div className="bg-surface-container border border-outline-variant rounded-lg p-md hover:border-primary transition-colors">
      <div className={`flex items-center justify-between gap-2 ${color}`}>
        {icon}
        <div className="text-right">
          <div className="text-2xl font-black">{value}</div>
          <div className="text-[10px] text-on-surface-variant uppercase font-bold">{label}</div>
        </div>
      </div>
    </div>
  );
}

function OverviewSection({ stats, onNavigate }: any) {
  return (
    <div className="space-y-lg">
      <div className="bg-surface-container border border-outline-variant rounded-lg p-lg">
        <h4 className="text-sm font-bold text-primary mb-md">System Status Overview</h4>
        <div className="space-y-3">
          <StatusItem
            icon={<CheckCircle2 className="w-5 h-5 text-green-400" />}
            label="Active Automation Rules"
            value={`${stats.activeRules} rules actively monitoring events`}
          />
          <StatusItem
            icon={<Clock className="w-5 h-5 text-blue-400" />}
            label="Scheduled Jobs"
            value={`${stats.scheduledJobs} jobs queued for execution`}
          />
          <StatusItem
            icon={<Bell className="w-5 h-5 text-yellow-400" />}
            label="Pending Notifications"
            value={`${stats.pendingNotifications} notifications awaiting delivery`}
          />
          <StatusItem
            icon={<TrendingUp className="w-5 h-5 text-green-400" />}
            label="Auto-Generated POs"
            value={`${stats.autoPOsCreated} purchase orders created automatically`}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-lg">
        <FeatureCard
          icon={<Zap className="w-6 h-6" />}
          title="Automation Rules"
          description="Define trigger-based workflows with conditions and actions"
          action="Manage Rules"
          onClick={() => onNavigate('rules')}
        />
        <FeatureCard
          icon={<Clock className="w-6 h-6" />}
          title="Scheduled Jobs"
          description="Configure background tasks with cron scheduling"
          action="View Jobs"
          onClick={() => onNavigate('jobs')}
        />
        <FeatureCard
          icon={<Bell className="w-6 h-6" />}
          title="Notifications"
          description="Queue and track alert delivery to users"
          action="View Notifications"
          onClick={() => onNavigate('notifications')}
        />
        <FeatureCard
          icon={<AlertCircle className="w-6 h-6" />}
          title="Auto-PO Creation"
          description="Automatically generate purchase orders for low stock"
          action="Configure Auto-PO"
          onClick={() => onNavigate('auto-po')}
        />
      </div>
    </div>
  );
}

function StatusItem({ icon, label, value }: any) {
  return (
    <div className="flex items-start gap-3 p-3 bg-surface-container-high rounded-lg">
      {icon}
      <div className="flex-1">
        <div className="text-xs font-bold text-on-surface uppercase">{label}</div>
        <div className="text-xs text-on-surface-variant mt-1">{value}</div>
      </div>
    </div>
  );
}

function FeatureCard({ icon, title, description, action, onClick }: any) {
  return (
    <div className="bg-surface-container border border-outline-variant rounded-lg p-lg hover:border-primary transition-all">
      <div className="text-primary mb-3">{icon}</div>
      <h5 className="text-sm font-bold text-on-surface mb-2">{title}</h5>
      <p className="text-xs text-on-surface-variant mb-4">{description}</p>
      <button onClick={onClick} className="text-xs font-bold text-primary hover:text-primary/80 transition-colors flex items-center gap-1">
        {action} <ChevronRight className="w-3 h-3" />
      </button>
    </div>
  );
}

function AutomationRulesSection({ triggerToast }: any) {
  const [rules, setRules] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [formData, setFormData] = useState({
    ruleName: '',
    description: '',
    triggerEvent: 'LOW_STOCK',
    ruleType: 'AUTO_PO',
    isActive: true,
  });

  useEffect(() => {
    fetchRules();
  }, []);

  const fetchRules = async () => {
    try {
      const res = await fetch('/api/automation-rules');
      setRules(await res.json());
    } catch (err: any) {
      triggerToast('Failed to load automation rules', 'ERROR');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateRule = async () => {
    if (!formData.ruleName.trim()) {
      triggerToast('Rule name is required', 'error');
      return;
    }
    try {
      const payload = {
        ...formData,
        // Provide default actions based on rule type if not already provided
        actions: formData.ruleType === 'AUTO_PO'
          ? { type: 'CREATE_PO', autoApprove: false }
          : formData.ruleType === 'MPN_ENRICHMENT'
          ? { type: 'ENRICH_SUPPLIERS', endpoint: '/api/automation/enrich-missing-suppliers' }
          : formData.ruleType === 'NOTIFICATION'
          ? { type: 'SEND_ALERT', channel: 'email' }
          : { type: formData.ruleType }
      };

      const res = await fetch('/api/automation-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        triggerToast('✅ Automation rule created successfully', 'success');
        setShowCreateForm(false);
        setFormData({ ruleName: '', description: '', triggerEvent: 'LOW_STOCK', ruleType: 'AUTO_PO', isActive: true });
        fetchRules();
      } else {
        const error = await res.json();
        triggerToast(`Failed: ${error.error || 'Unknown error'}`, 'error');
      }
    } catch (err: any) {
      triggerToast(`Error: ${err.message}`, 'error');
    }
  };

  if (loading) return <div className="text-center py-8 text-outline">Loading...</div>;

  return (
    <div className="space-y-md">
      <button onClick={() => setShowCreateForm(!showCreateForm)} className="px-lg py-2 rounded-lg bg-primary text-on-primary text-xs font-bold hover:brightness-110 transition flex items-center gap-2">
        <Plus className="w-4 h-4" />
        Create Automation Rule
      </button>

      {showCreateForm && (
        <div className="bg-surface-container border border-outline-variant rounded-lg p-lg space-y-md">
          <h4 className="text-sm font-bold text-on-surface">New Automation Rule</h4>
          <div className="space-y-sm">
            <div>
              <label className="text-xs font-bold text-on-surface-variant block mb-1">Rule Name</label>
              <input
                type="text"
                value={formData.ruleName}
                onChange={(e) => setFormData({ ...formData, ruleName: e.target.value })}
                placeholder="e.g., Auto-order resistors when low"
                className="w-full bg-surface-container-high border border-outline-variant rounded px-2 py-1.5 text-xs text-on-surface"
              />
            </div>
            <div>
              <label className="text-xs font-bold text-on-surface-variant block mb-1">Description</label>
              <textarea
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Brief description of what this rule does"
                className="w-full bg-surface-container-high border border-outline-variant rounded px-2 py-1.5 text-xs text-on-surface"
                rows={2}
              />
            </div>
            <div className="grid grid-cols-2 gap-sm">
              <div>
                <label className="text-xs font-bold text-on-surface-variant block mb-1">Trigger Event</label>
                <select
                  value={formData.triggerEvent}
                  onChange={(e) => setFormData({ ...formData, triggerEvent: e.target.value })}
                  className="w-full bg-surface-container-high border border-outline-variant rounded px-2 py-1.5 text-xs text-on-surface"
                >
                  <option>LOW_STOCK</option>
                  <option>CRITICAL_STOCK</option>
                  <option>OUT_OF_STOCK</option>
                  <option>MISSING_SUPPLIER</option>
                  <option>SCHEDULED</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-bold text-on-surface-variant block mb-1">Rule Type</label>
                <select
                  value={formData.ruleType}
                  onChange={(e) => setFormData({ ...formData, ruleType: e.target.value })}
                  className="w-full bg-surface-container-high border border-outline-variant rounded px-2 py-1.5 text-xs text-on-surface"
                >
                  <option>AUTO_PO</option>
                  <option>MPN_ENRICHMENT</option>
                  <option>NOTIFICATION</option>
                  <option>CUSTOM</option>
                </select>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={formData.isActive}
                onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })}
                className="rounded"
              />
              <label className="text-xs text-on-surface-variant">Activate immediately</label>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={handleCreateRule} className="flex-1 px-3 py-1.5 rounded bg-primary text-on-primary text-xs font-bold hover:brightness-110 transition">
              Create Rule
            </button>
            <button onClick={() => setShowCreateForm(false)} className="flex-1 px-3 py-1.5 rounded bg-surface-container-high border border-outline-variant text-on-surface text-xs font-bold hover:bg-surface-variant transition">
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="space-y-md">
        {rules.length === 0 ? (
          <div className="text-center py-8 text-outline italic">No automation rules configured</div>
        ) : (
          rules.map(rule => (
            <div key={rule.id} className="bg-surface-container border border-outline-variant rounded-lg p-md">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <h5 className="text-sm font-bold text-on-surface">{rule.ruleName}</h5>
                    {rule.isActive ? (
                      <span className="px-2 py-1 rounded text-[9px] font-bold bg-green-500/10 text-green-400">ACTIVE</span>
                    ) : (
                      <span className="px-2 py-1 rounded text-[9px] font-bold bg-gray-500/10 text-outline">INACTIVE</span>
                    )}
                  </div>
                  <p className="text-xs text-on-surface-variant">{rule.description}</p>
                  <div className="text-[10px] text-outline mt-2">
                    Trigger: <span className="font-mono">{rule.triggerEvent}</span> | Type: {rule.ruleType}
                  </div>
                </div>
                <button className="p-2 hover:bg-surface-container-high rounded transition">
                  <ChevronRight className="w-4 h-4 text-on-surface-variant" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ScheduledJobsSection({ triggerToast }: any) {
  const [jobs, setJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJobs();
  }, []);

  const fetchJobs = async () => {
    try {
      const res = await fetch('/api/scheduled-jobs');
      setJobs(await res.json());
    } catch (err: any) {
      triggerToast('Failed to load scheduled jobs', 'error');
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div className="text-center py-4 text-outline text-xs">Loading...</div>;

  return (
    <div className="space-y-md">
      <div className="flex items-center justify-between mb-md">
        <h4 className="text-sm font-bold text-on-surface">Scheduled Jobs ({jobs.length})</h4>
        <button onClick={fetchJobs} className="text-xs text-primary hover:text-primary/80 transition">Refresh</button>
      </div>
      {jobs.length === 0 ? (
        <p className="text-xs text-on-surface-variant italic">No scheduled jobs configured</p>
      ) : (
        <div className="space-y-sm">
          {jobs.map((job: any) => (
            <div key={job.id} className="bg-surface-container-high/30 p-sm rounded border border-outline-variant/30">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <p className="text-xs font-bold text-on-surface">{job.jobName}</p>
                  <p className="text-[10px] text-on-surface-variant mt-1">Type: {job.jobType} | Schedule: {job.scheduleType}</p>
                  <p className="text-[10px] text-outline mt-1">Next run: {new Date(job.nextRun).toLocaleString()}</p>
                </div>
                <span className={`px-2 py-0.5 rounded text-[9px] font-bold ${job.isActive ? 'bg-green-500/10 text-green-400' : 'bg-gray-500/10 text-gray-400'}`}>
                  {job.isActive ? 'ACTIVE' : 'INACTIVE'}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NotificationsSection({ triggerToast }: any) {
  const [notifications, setNotifications] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchNotifications();
  }, []);

  const fetchNotifications = async () => {
    try {
      const res = await fetch('/api/notifications?status=PENDING');
      setNotifications(await res.json());
    } catch (err: any) {
      triggerToast('Failed to load notifications', 'error');
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div className="text-center py-4 text-outline text-xs">Loading...</div>;

  return (
    <div className="space-y-md">
      <div className="flex items-center justify-between mb-md">
        <h4 className="text-sm font-bold text-on-surface">Pending Notifications ({notifications.length})</h4>
        <button onClick={fetchNotifications} className="text-xs text-primary hover:text-primary/80 transition">Refresh</button>
      </div>
      {notifications.length === 0 ? (
        <p className="text-xs text-on-surface-variant italic">No pending notifications</p>
      ) : (
        <div className="space-y-sm max-h-72 overflow-y-auto">
          {notifications.map((notif: any) => (
            <div key={notif.id} className="bg-surface-container-high/30 p-sm rounded border-l-2 border-primary">
              <p className="text-xs font-bold text-on-surface">{notif.subject || notif.message}</p>
              <p className="text-[10px] text-on-surface-variant mt-1">{notif.message}</p>
              <p className="text-[9px] text-outline mt-2">{new Date(notif.createdAt).toLocaleString()}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AutoPOConfigSection({ triggerToast }: any) {
  const [config, setConfig] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    fetchConfig();
  }, []);

  const fetchConfig = async () => {
    try {
      const res = await fetch('/api/auto-po-config');
      const data = await res.json();
      setConfig(data[0] || { enabled: false, minStockLevel: 50, preferredSupplier: 'digikey', autoApprove: false });
    } catch (err: any) {
      triggerToast('Failed to load auto-PO config', 'error');
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div className="text-center py-4 text-outline text-xs">Loading...</div>;

  return (
    <div className="space-y-md">
      <div className="flex items-center justify-between mb-md">
        <h4 className="text-sm font-bold text-on-surface">Auto-PO Settings</h4>
        <button onClick={() => setEditing(!editing)} className="text-xs text-primary hover:text-primary/80 transition">
          {editing ? 'Done' : 'Edit'}
        </button>
      </div>
      <div className="bg-surface-container-high/30 p-md rounded space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-on-surface-variant">Auto-PO Enabled:</span>
          <span className="text-xs font-bold text-on-surface">{config?.enabled ? '✓ Yes' : '✗ No'}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-on-surface-variant">Min Stock Level:</span>
          <span className="text-xs font-bold text-on-surface">{config?.minStockLevel || 50} units</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-on-surface-variant">Preferred Supplier:</span>
          <span className="text-xs font-bold text-on-surface">{config?.preferredSupplier || 'digikey'}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-on-surface-variant">Auto-Approve:</span>
          <span className="text-xs font-bold text-on-surface">{config?.autoApprove ? '✓ Yes' : '✗ No'}</span>
        </div>
      </div>
      {editing && (
        <p className="text-[10px] text-outline italic">Configuration editor coming soon...</p>
      )}
    </div>
  );
}

function EventLogSection({ triggerToast }: any) {
  const [events, setEvents] = useState<any[]>([]);
  const [rules, setRules] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000); // Auto-refresh every 5 seconds
    return () => clearInterval(interval);
  }, []);

  const fetchData = async () => {
    try {
      const [eventsRes, rulesRes] = await Promise.all([
        fetch('/api/event-log?limit=50'),
        fetch('/api/automation-rules')
      ]);
      setEvents(await eventsRes.json());
      const rulesData = await rulesRes.json();
      setRules(rulesData.filter((r: any) => r.isActive));
    } catch (err: any) {
      triggerToast('Failed to load data', 'ERROR');
    } finally {
      setLoading(false);
    }
  };

  const getEventDescription = (eventType: string, details: any) => {
    const descriptions: Record<string, string> = {
      'AUTO_PO_CREATED': `✓ Auto-purchase order created for ${details?.componentId || 'item'}`,
      'MPN_ENRICHMENT': `✓ Supplier information enriched for missing data`,
      'LOW_STOCK_ALERT': `⚠ Low stock alert triggered`,
      'CRITICAL_STOCK': `🚨 Critical stock threshold reached`,
      'AUTO_TRIGGER': `🤖 Automation rule triggered`,
      'ENRICH_SUPPLIERS': `✓ Supplier enrichment completed`
    };
    return descriptions[eventType] || eventType;
  };

  if (loading) return <div className="text-center py-8 text-outline">Loading...</div>;

  return (
    <div className="space-y-md">
      {/* Active Rules Summary */}
      <div className="bg-surface-container-high/40 border border-primary/20 rounded-lg p-md">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-green-500"></span>
          <span className="text-xs font-bold text-on-surface uppercase">Active Automation Rules</span>
          <span className="text-xs font-mono bg-primary/20 text-primary px-2 py-1 rounded">{rules.length} rules actively monitoring events</span>
        </div>
      </div>

      {/* Event Log Table */}
      <div className="overflow-x-auto border border-outline-variant rounded-lg">
        <table className="w-full text-left text-xs">
          <thead className="bg-surface-container-high border-b border-outline-variant">
            <tr>
              <th className="px-md py-2 font-bold text-outline uppercase">Event</th>
              <th className="px-md py-2 font-bold text-outline uppercase">Details</th>
              <th className="px-md py-2 font-bold text-outline uppercase">Status</th>
              <th className="px-md py-2 font-bold text-outline uppercase">Time</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-outline-variant/30">
            {events.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-md py-4 text-center text-on-surface-variant text-[10px]">
                  No events recorded yet. Automation rules will log events here.
                </td>
              </tr>
            ) : (
              events.map(event => (
                <tr key={event.id} className="hover:bg-surface-variant/20 transition">
                  <td className="px-md py-2 font-mono text-primary font-bold">{event.eventType}</td>
                  <td className="px-md py-2 text-on-surface">
                    <div className="flex flex-col gap-0.5">
                      <span>{getEventDescription(event.eventType, event.details ? JSON.parse(event.details) : {})}</span>
                      {event.entityType && (
                        <span className="text-[9px] text-outline">{event.entityType}: {event.action}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-md py-2">
                    <span className={`px-2 py-1 rounded text-[9px] font-bold inline-block ${
                      event.status === 'SUCCESS'
                        ? 'bg-green-500/10 text-green-400'
                        : event.status === 'PENDING'
                        ? 'bg-yellow-500/10 text-yellow-400'
                        : 'bg-red-500/10 text-red-400'
                    }`}>
                      {event.status}
                    </span>
                  </td>
                  <td className="px-md py-2 text-on-surface-variant text-[10px] whitespace-nowrap">
                    {new Date(event.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
