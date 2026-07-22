import React, { useState, useEffect } from 'react';
import { Plus, Trash2, Edit2, Lock, User as UserIcon } from 'lucide-react';
import { User, UserRole } from '../types';

interface UserManagementProps {
  triggerToast: (msg: string, type?: string) => void;
}

export default function UserManagement({ triggerToast }: UserManagementProps) {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formData, setFormData] = useState<Partial<User>>({
    email: '',
    firstName: '',
    lastName: '',
    role: 'viewer',
    status: 'ACTIVE'
  });

  useEffect(() => {
    fetchUsers();
  }, []);

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/users');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setUsers(Array.isArray(data) ? data : []);
      triggerToast('Users loaded', 'success');
    } catch (err: any) {
      triggerToast(err.message || 'Failed to load users', 'error');
      setUsers([]);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.email) {
      triggerToast('Email is required', 'error');
      return;
    }

    try {
      if (editingId) {
        // Update user
        const res = await fetch(`/api/users/${editingId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            firstName: formData.firstName,
            lastName: formData.lastName,
            role: formData.role,
            status: formData.status
          })
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        triggerToast('User updated successfully', 'success');
      } else {
        // Create new user
        if (!formData.password) {
          triggerToast('Password is required for new users', 'error');
          return;
        }

        const res = await fetch('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: formData.email,
            password: formData.password,
            firstName: formData.firstName,
            lastName: formData.lastName,
            role: formData.role
          })
        });

        if (!res.ok) {
          const error = await res.json();
          throw new Error(error.error || `HTTP ${res.status}`);
        }
        triggerToast('User created successfully', 'success');
      }

      setShowForm(false);
      setEditingId(null);
      setFormData({
        email: '',
        firstName: '',
        lastName: '',
        role: 'viewer',
        status: 'ACTIVE',
        password: ''
      });
      fetchUsers();
    } catch (err: any) {
      triggerToast(err.message, 'error');
    }
  };

  const handleEdit = (user: User) => {
    setEditingId(user.id || null);
    setFormData(user);
    setShowForm(true);
  };

  const handleDelete = async (id: number | undefined) => {
    if (!id || !window.confirm('Are you sure? This action cannot be undone.')) return;

    try {
      const res = await fetch(`/api/users/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      triggerToast('User deleted', 'success');
      fetchUsers();
    } catch (err: any) {
      triggerToast(err.message, 'error');
    }
  };

  const getRoleColor = (role: UserRole) => {
    switch (role) {
      case 'admin':
        return 'bg-red-500/10 text-red-400 border-red-500/20';
      case 'manager':
        return 'bg-blue-500/10 text-blue-400 border-blue-500/20';
      case 'viewer':
        return 'bg-gray-500/10 text-gray-400 border-gray-500/20';
      default:
        return 'bg-surface-container-high/30';
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'ACTIVE':
        return 'bg-green-500/10 text-green-400 border-green-500/20';
      case 'INACTIVE':
        return 'bg-gray-500/10 text-gray-400 border-gray-500/20';
      case 'SUSPENDED':
        return 'bg-red-500/10 text-red-400 border-red-500/20';
      default:
        return 'bg-surface-container-high/30';
    }
  };

  return (
    <div className="space-y-lg">
      <div className="flex justify-between items-center">
        <div>
          <h3 className="text-lg font-bold text-on-surface flex items-center gap-sm">
            <UserIcon className="w-5 h-5 text-primary" />
            User Management
          </h3>
          <p className="text-xs text-on-surface-variant mt-1">Create and manage system users with role-based access</p>
        </div>
        <button
          onClick={() => {
            setEditingId(null);
            setFormData({
              email: '',
              firstName: '',
              lastName: '',
              role: 'viewer',
              status: 'ACTIVE',
              password: ''
            });
            setShowForm(!showForm);
          }}
          className="px-lg py-sm rounded-lg bg-primary text-on-primary font-bold text-xs flex items-center gap-xs hover:brightness-110 transition-all"
        >
          <Plus className="w-4 h-4" />
          Add User
        </button>
      </div>

      {showForm && (
        <div className="bg-surface-container border border-outline-variant rounded-lg p-lg space-y-md">
          <h4 className="font-bold text-on-surface">
            {editingId ? 'Edit User' : 'Create New User'}
          </h4>
          <form onSubmit={handleSubmit} className="space-y-md">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
              <div>
                <label className="block text-xs font-bold text-on-surface mb-2">Email *</label>
                <input
                  type="email"
                  value={formData.email || ''}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  disabled={!!editingId}
                  className="w-full px-3 py-2 bg-surface-container-high border border-outline-variant rounded text-xs"
                  placeholder="user@example.com"
                />
              </div>
              {!editingId && (
                <div>
                  <label className="block text-xs font-bold text-on-surface mb-2">Password *</label>
                  <input
                    type="password"
                    value={(formData as any).password || ''}
                    onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                    className="w-full px-3 py-2 bg-surface-container-high border border-outline-variant rounded text-xs"
                    placeholder="••••••••"
                  />
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
              <div>
                <label className="block text-xs font-bold text-on-surface mb-2">First Name</label>
                <input
                  type="text"
                  value={formData.firstName || ''}
                  onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
                  className="w-full px-3 py-2 bg-surface-container-high border border-outline-variant rounded text-xs"
                  placeholder="John"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-on-surface mb-2">Last Name</label>
                <input
                  type="text"
                  value={formData.lastName || ''}
                  onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
                  className="w-full px-3 py-2 bg-surface-container-high border border-outline-variant rounded text-xs"
                  placeholder="Doe"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
              <div>
                <label className="block text-xs font-bold text-on-surface mb-2">Role</label>
                <select
                  value={formData.role || 'viewer'}
                  onChange={(e) => setFormData({ ...formData, role: e.target.value as UserRole })}
                  className="w-full px-3 py-2 bg-surface-container-high border border-outline-variant rounded text-xs"
                >
                  <option value="viewer">Viewer (Read-Only)</option>
                  <option value="manager">Manager</option>
                  <option value="admin">Administrator</option>
                </select>
              </div>
              {editingId && (
                <div>
                  <label className="block text-xs font-bold text-on-surface mb-2">Status</label>
                  <select
                    value={formData.status || 'ACTIVE'}
                    onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                    className="w-full px-3 py-2 bg-surface-container-high border border-outline-variant rounded text-xs"
                  >
                    <option value="ACTIVE">Active</option>
                    <option value="INACTIVE">Inactive</option>
                    <option value="SUSPENDED">Suspended</option>
                  </select>
                </div>
              )}
            </div>

            <div className="flex gap-md justify-end">
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="px-lg py-sm rounded-lg bg-surface-container-high text-on-surface font-bold text-xs hover:bg-surface-variant transition-all"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-lg py-sm rounded-lg bg-primary text-on-primary font-bold text-xs hover:brightness-110 transition-all"
              >
                {editingId ? 'Update User' : 'Create User'}
              </button>
            </div>
          </form>
        </div>
      )}

      {loading ? (
        <div className="text-center py-lg text-on-surface-variant">Loading users...</div>
      ) : users.length === 0 ? (
        <div className="text-center py-lg text-on-surface-variant">No users yet. Create one to get started.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-surface-container-high/50 border-b border-outline-variant">
                <th className="px-lg py-sm text-[11px] font-label-caps text-outline">Email</th>
                <th className="px-lg py-sm text-[11px] font-label-caps text-outline">Name</th>
                <th className="px-lg py-sm text-[11px] font-label-caps text-outline">Role</th>
                <th className="px-lg py-sm text-[11px] font-label-caps text-outline">Status</th>
                <th className="px-lg py-sm text-[11px] font-label-caps text-outline">Created</th>
                <th className="px-lg py-sm text-[11px] font-label-caps text-outline text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30">
              {users.map((user) => (
                <tr key={user.id} className="hover:bg-surface-variant/20 transition-colors">
                  <td className="px-lg py-sm text-xs text-on-surface font-mono">{user.email}</td>
                  <td className="px-lg py-sm text-xs text-on-surface">
                    {user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : '—'}
                  </td>
                  <td className="px-lg py-sm">
                    <span className={`text-xs font-bold px-2 py-1 rounded border inline-block ${getRoleColor(user.role)}`}>
                      {user.role.charAt(0).toUpperCase() + user.role.slice(1)}
                    </span>
                  </td>
                  <td className="px-lg py-sm">
                    <span className={`text-xs font-bold px-2 py-1 rounded border inline-block ${getStatusColor(user.status || 'ACTIVE')}`}>
                      {user.status || 'ACTIVE'}
                    </span>
                  </td>
                  <td className="px-lg py-sm text-xs text-on-surface-variant">
                    {user.createdAt ? new Date(user.createdAt).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-lg py-sm text-right">
                    <div className="flex justify-end gap-xs">
                      <button
                        onClick={() => handleEdit(user)}
                        className="p-1.5 text-blue-400 hover:bg-blue-500/10 rounded transition-colors"
                        title="Edit user"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(user.id)}
                        className="p-1.5 text-red-400 hover:bg-red-500/10 rounded transition-colors"
                        title="Delete user"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-md text-xs text-blue-400">
        <p className="font-bold mb-1">Role Permissions:</p>
        <ul className="space-y-1 text-xs">
          <li>• <strong>Admin:</strong> Full system access, create/manage users, change settings</li>
          <li>• <strong>Manager:</strong> Create items, manage inventory, create orders</li>
          <li>• <strong>Viewer:</strong> Read-only access to all data</li>
        </ul>
      </div>
    </div>
  );
}
