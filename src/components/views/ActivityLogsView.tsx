import React, { useState, useEffect } from 'react';
import { Search, Filter, Download, RefreshCw, AlertCircle, CheckCircle2 } from 'lucide-react';
import { fetchActivityLogs } from '../../lib/activityLogger';

interface ActivityLog {
  id: number;
  user_email: string;
  action: string;
  entity_type: string;
  entity_id: string;
  details: string;
  ip_address: string;
  user_agent: string;
  status: 'SUCCESS' | 'ERROR';
  error_message: string | null;
  created_at: string;
}

interface ActivityLogsViewProps {
  currentUserEmail?: string;
}

export const ActivityLogsView: React.FC<ActivityLogsViewProps> = ({ currentUserEmail }) => {
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedAction, setSelectedAction] = useState<string>('ALL');
  const [selectedStatus, setSelectedStatus] = useState<string>('ALL');
  const [selectedUser, setSelectedUser] = useState<string>('ALL');
  const [uniqueActions, setUniqueActions] = useState<string[]>([]);
  const [uniqueUsers, setUniqueUsers] = useState<string[]>([]);
  const [expandedLogId, setExpandedLogId] = useState<number | null>(null);

  const fetchLogs = async () => {
    setIsLoading(true);
    try {
      const allLogs = await fetchActivityLogs(undefined, undefined, 500, 0);
      setLogs(allLogs);

      const actions = [...new Set(allLogs.map((l: any) => l.action))].sort();
      const users = [...new Set(allLogs.map((l: any) => l.user_email))].sort();
      setUniqueActions(actions);
      setUniqueUsers(users);
    } catch (err) {
      console.error('Failed to fetch activity logs:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
  }, []);

  const filteredLogs = logs.filter(log => {
    const matchesSearch = searchQuery === '' ||
      log.user_email.toLowerCase().includes(searchQuery.toLowerCase()) ||
      log.action.toLowerCase().includes(searchQuery.toLowerCase()) ||
      log.entity_id.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesAction = selectedAction === 'ALL' || log.action === selectedAction;
    const matchesStatus = selectedStatus === 'ALL' || log.status === selectedStatus;
    const matchesUser = selectedUser === 'ALL' || log.user_email === selectedUser;

    return matchesSearch && matchesAction && matchesStatus && matchesUser;
  });

  const getActionColor = (action: string) => {
    if (action.startsWith('CREATE')) return 'text-green-400 bg-green-500/10';
    if (action.startsWith('UPDATE')) return 'text-blue-400 bg-blue-500/10';
    if (action.startsWith('DELETE')) return 'text-red-400 bg-red-500/10';
    if (action === 'LOGIN') return 'text-purple-400 bg-purple-500/10';
    if (action === 'LOGOUT') return 'text-orange-400 bg-orange-500/10';
    return 'text-on-surface-variant bg-surface-container-high';
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  return (
    <div className="p-container-margin space-y-4 max-w-7xl mx-auto w-full">
      {/* Header */}
      <div className="flex justify-between items-end mb-lg">
        <div>
          <h3 className="font-headline-sm text-lg text-on-surface">User Activity Logs</h3>
          <p className="text-on-surface-variant font-body-sm">
            Track and audit all user actions across the system.
          </p>
        </div>
        <button
          onClick={() => fetchLogs()}
          disabled={isLoading}
          className="bg-primary text-on-primary px-3 py-1.5 rounded-lg font-bold text-xs shadow-md shadow-primary/10 hover:brightness-110 active:scale-95 transition-all duration-150 flex items-center gap-1.5 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Filtering Toolbar */}
      <div className="bg-surface-container border border-outline-variant rounded-xl p-3 shadow-sm flex flex-wrap items-center gap-4 text-xs">
        {/* Text Search */}
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-outline" />
          <input
            type="text"
            placeholder="Search user, action, entity..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-surface-container-high border border-outline-variant rounded-lg pl-8 pr-6 py-1.5 text-xs text-on-surface focus:outline-none focus:border-primary placeholder-outline/50"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-outline hover:text-on-surface text-[10px] font-bold"
            >
              ✕
            </button>
          )}
        </div>

        {/* Action Filter */}
        <div className="flex items-center gap-1.5">
          <span className="text-outline text-[11px] font-medium">Action:</span>
          <select
            value={selectedAction}
            onChange={(e) => setSelectedAction(e.target.value)}
            className="bg-surface-container-high border border-outline-variant rounded px-2 py-1 text-xs cursor-pointer focus:outline-none focus:border-primary text-on-surface"
          >
            <option value="ALL">All Actions</option>
            {uniqueActions.map(action => (
              <option key={action} value={action}>{action}</option>
            ))}
          </select>
        </div>

        {/* Status Filter */}
        <div className="flex items-center gap-1.5">
          <span className="text-outline text-[11px] font-medium">Status:</span>
          <select
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value)}
            className="bg-surface-container-high border border-outline-variant rounded px-2 py-1 text-xs cursor-pointer focus:outline-none focus:border-primary text-on-surface"
          >
            <option value="ALL">All Status</option>
            <option value="SUCCESS">Success</option>
            <option value="ERROR">Error</option>
          </select>
        </div>

        {/* User Filter */}
        <div className="flex items-center gap-1.5">
          <span className="text-outline text-[11px] font-medium">User:</span>
          <select
            value={selectedUser}
            onChange={(e) => setSelectedUser(e.target.value)}
            className="bg-surface-container-high border border-outline-variant rounded px-2 py-1 text-xs cursor-pointer focus:outline-none focus:border-primary text-on-surface"
          >
            <option value="ALL">All Users</option>
            {uniqueUsers.map(user => (
              <option key={user} value={user}>{user}</option>
            ))}
          </select>
        </div>

        {/* Results Counter */}
        <div className="ml-auto text-outline font-mono text-[11px]">
          Results: <span className="text-primary font-bold">{filteredLogs.length}</span>
        </div>
      </div>

      {/* Logs Table */}
      <div className="bg-surface-container rounded-xl border border-outline-variant overflow-hidden shadow-md">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-surface-container-high/50 font-label-caps text-[10px] text-outline border-b border-outline-variant">
                <th className="px-lg py-sm w-32">Timestamp</th>
                <th className="px-lg py-sm w-32">User</th>
                <th className="px-lg py-sm w-28">Action</th>
                <th className="px-lg py-sm w-24">Entity Type</th>
                <th className="px-lg py-sm w-32">Entity ID</th>
                <th className="px-lg py-sm w-16">Status</th>
                <th className="px-lg py-sm w-24">IP Address</th>
                <th className="px-lg py-sm text-center">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30 text-xs text-on-surface">
              {filteredLogs.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-lg py-md text-center text-on-surface-variant">
                    No activity logs found
                  </td>
                </tr>
              ) : (
                filteredLogs.map(log => (
                  <React.Fragment key={log.id}>
                    <tr className="hover:bg-surface-variant/20 transition-all duration-150">
                      <td className="px-lg py-sm font-mono text-[10px]">
                        {formatDate(log.created_at)}
                      </td>
                      <td className="px-lg py-sm">
                        <span className="font-bold text-primary">{log.user_email}</span>
                      </td>
                      <td className="px-lg py-sm">
                        <span className={`inline-block px-2 py-1 rounded font-bold ${getActionColor(log.action)}`}>
                          {log.action}
                        </span>
                      </td>
                      <td className="px-lg py-sm font-mono text-[10px]">
                        {log.entity_type || '—'}
                      </td>
                      <td className="px-lg py-sm font-mono text-[10px] truncate max-w-xs">
                        {log.entity_id || '—'}
                      </td>
                      <td className="px-lg py-sm text-center">
                        {log.status === 'SUCCESS' ? (
                          <CheckCircle2 className="w-4 h-4 text-green-400 inline" title="Success" />
                        ) : (
                          <AlertCircle className="w-4 h-4 text-red-400 inline" title="Error" />
                        )}
                      </td>
                      <td className="px-lg py-sm font-mono text-[10px]">
                        {log.ip_address || '—'}
                      </td>
                      <td className="px-lg py-sm text-center">
                        <button
                          onClick={() => setExpandedLogId(expandedLogId === log.id ? null : log.id)}
                          className="text-primary hover:text-primary/80 font-bold p-1 hover:bg-primary/10 rounded transition-all"
                        >
                          {expandedLogId === log.id ? '▼' : '▶'}
                        </button>
                      </td>
                    </tr>
                    {expandedLogId === log.id && (
                      <tr className="bg-surface-container-high/30">
                        <td colSpan={8} className="px-lg py-md">
                          <div className="space-y-2 text-xs">
                            <div>
                              <span className="font-bold text-outline">Details:</span>
                              <pre className="bg-surface-container rounded p-2 mt-1 text-[10px] overflow-x-auto font-mono">
                                {(() => {
                                  try {
                                    // Handle both string and object formats
                                    let details = log.details;

                                    // If it's a string, try to parse it
                                    if (typeof details === 'string') {
                                      try {
                                        details = JSON.parse(details);
                                      } catch {
                                        // If parsing fails, treat as plain string
                                        return details || '{}';
                                      }
                                    }

                                    // If we have an object, stringify it
                                    if (details && typeof details === 'object') {
                                      return JSON.stringify(details, null, 2);
                                    }

                                    return '{}';
                                  } catch (e) {
                                    console.error('Error displaying activity details:', e);
                                    return '{}';
                                  }
                                })()}
                              </pre>
                            </div>
                            <div>
                              <span className="font-bold text-outline">User Agent:</span>
                              <p className="text-on-surface-variant break-words mt-1">{log.user_agent}</p>
                            </div>
                            {log.error_message && (
                              <div>
                                <span className="font-bold text-error">Error:</span>
                                <p className="text-error/80 mt-1">{log.error_message}</p>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-md">
        <div className="bg-surface-container p-md border border-outline-variant rounded-xl">
          <p className="text-[11px] text-outline uppercase font-label-caps">Total Logs</p>
          <p className="text-2xl font-bold text-on-surface mt-1">{logs.length}</p>
        </div>
        <div className="bg-surface-container p-md border border-outline-variant rounded-xl">
          <p className="text-[11px] text-outline uppercase font-label-caps">Successful Actions</p>
          <p className="text-2xl font-bold text-green-400 mt-1">
            {logs.filter(l => l.status === 'SUCCESS').length}
          </p>
        </div>
        <div className="bg-surface-container p-md border border-outline-variant rounded-xl">
          <p className="text-[11px] text-outline uppercase font-label-caps">Failed Actions</p>
          <p className="text-2xl font-bold text-red-400 mt-1">
            {logs.filter(l => l.status === 'ERROR').length}
          </p>
        </div>
        <div className="bg-surface-container p-md border border-outline-variant rounded-xl">
          <p className="text-[11px] text-outline uppercase font-label-caps">Unique Users</p>
          <p className="text-2xl font-bold text-primary mt-1">{uniqueUsers.length}</p>
        </div>
      </div>
    </div>
  );
};
