import { useState, useCallback } from 'react';
import {
  AutomationRuleState,
  ScheduledJobState,
  AutomationRule,
  ScheduledJob
} from '../types';
import {
  canTransitionState,
  canTransitionJobState,
  getStateColor,
  getStateBgColor,
  getStateBorderColor,
  getStateLabel
} from '../lib/automationStates';

export function useAutomationState() {
  const [automationRules, setAutomationRules] = useState<AutomationRule[]>([]);
  const [scheduledJobs, setScheduledJobs] = useState<ScheduledJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateRuleState = useCallback(async (
    ruleId: number,
    newState: AutomationRuleState
  ) => {
    try {
      const currentRule = automationRules.find(r => r.id === ruleId);
      if (!currentRule) throw new Error('Rule not found');

      if (!canTransitionState(currentRule.state, newState)) {
        throw new Error(`Cannot transition from ${currentRule.state} to ${newState}`);
      }

      const res = await fetch(`/api/automation-rules/${ruleId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: newState })
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      setAutomationRules(prev =>
        prev.map(r => r.id === ruleId ? { ...r, state: newState } : r)
      );
    } catch (err: any) {
      setError(err.message);
      throw err;
    }
  }, [automationRules]);

  const updateJobState = useCallback(async (
    jobId: number,
    newState: ScheduledJobState
  ) => {
    try {
      const currentJob = scheduledJobs.find(j => j.id === jobId);
      if (!currentJob) throw new Error('Job not found');

      if (!canTransitionJobState(currentJob.state, newState)) {
        throw new Error(`Cannot transition from ${currentJob.state} to ${newState}`);
      }

      const res = await fetch(`/api/scheduled-jobs/${jobId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: newState })
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      setScheduledJobs(prev =>
        prev.map(j => j.id === jobId ? { ...j, state: newState } : j)
      );
    } catch (err: any) {
      setError(err.message);
      throw err;
    }
  }, [scheduledJobs]);

  const fetchRules = useCallback(async (filters?: Record<string, any>) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters) {
        Object.entries(filters).forEach(([key, value]) => {
          if (value !== undefined && value !== null) {
            params.append(key, String(value));
          }
        });
      }

      const res = await fetch(`/api/automation-rules?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      setAutomationRules(Array.isArray(data) ? data : []);
      setError(null);
    } catch (err: any) {
      setError(err.message);
      setAutomationRules([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchJobs = useCallback(async (filters?: Record<string, any>) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters) {
        Object.entries(filters).forEach(([key, value]) => {
          if (value !== undefined && value !== null) {
            params.append(key, String(value));
          }
        });
      }

      const res = await fetch(`/api/scheduled-jobs?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      setScheduledJobs(Array.isArray(data) ? data : []);
      setError(null);
    } catch (err: any) {
      setError(err.message);
      setScheduledJobs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const createRule = useCallback(async (rule: AutomationRule) => {
    try {
      const res = await fetch('/api/automation-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rule)
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const newRule = await res.json();
      setAutomationRules(prev => [...prev, newRule]);
      return newRule;
    } catch (err: any) {
      setError(err.message);
      throw err;
    }
  }, []);

  const deleteRule = useCallback(async (ruleId: number) => {
    try {
      const res = await fetch(`/api/automation-rules/${ruleId}`, {
        method: 'DELETE'
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      setAutomationRules(prev => prev.filter(r => r.id !== ruleId));
    } catch (err: any) {
      setError(err.message);
      throw err;
    }
  }, []);

  return {
    automationRules,
    scheduledJobs,
    loading,
    error,
    updateRuleState,
    updateJobState,
    fetchRules,
    fetchJobs,
    createRule,
    deleteRule,
    getStateColor,
    getStateBgColor,
    getStateBorderColor,
    getStateLabel
  };
}
