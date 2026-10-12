// Whether the signed-in user may make a change, for showing or hiding the
// button that makes it. The same rule list the server checks every change
// against (./writeAccess), with the role kept at sign-in, so a button shows
// exactly when the server would allow it. The server still checks.

import { currentUserRole, roleCan } from './permissions';
import { permissionForWrite } from './writeAccess';

/** Whether a change (POST, PUT, PATCH or DELETE) to an API path is allowed for the signed-in user. */
export function canChange(path: string, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'POST', role: string | null = currentUserRole()): boolean {
  const needed = permissionForWrite(method, path);
  if (!needed) return true;
  if (needed === 'not-viewer') return String(role ?? '').toLowerCase() !== 'viewer';
  return roleCan(role, needed);
}
