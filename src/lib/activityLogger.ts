export interface ActivityLog {
  userEmail: string;
  action: string;
  entityType?: string;
  entityId?: string;
  details?: Record<string, any>;
  status?: 'SUCCESS' | 'ERROR';
}

export async function logActivity(log: ActivityLog): Promise<void> {
  try {
    const res = await fetch('/api/activity-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(log),
    });

    if (!res.ok) {
      console.error('Activity log API error:', res.status, res.statusText);
      return;
    }

    await res.json().catch(() => {
      // Ignore response parsing errors
      console.warn('Could not parse activity log response');
    });
  } catch (err) {
    console.error('Failed to log activity:', err);
  }
}

export async function fetchActivityLogs(
  userEmail?: string,
  action?: string,
  limit: number = 100,
  offset: number = 0
): Promise<any[]> {
  const params = new URLSearchParams();
  if (userEmail) params.append('userEmail', userEmail);
  if (action) params.append('action', action);
  params.append('limit', String(limit));
  params.append('offset', String(offset));

  const res = await fetch(`/api/activity-logs?${params}`);
  if (!res.ok) throw new Error('Failed to fetch activity logs');
  return res.json();
}
