'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession } from '@/hooks/use-session'
import Button from '@/components/ui/button'
import Badge from '@/components/ui/badge'
import Modal from '@/components/ui/modal'
import Input from '@/components/ui/input'
import {
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeader,
  TableCell,
} from '@/components/ui/table'
import {
  Users,
  Plus,
  AlertTriangle,
  Loader2,
  ArrowLeft,
  Pencil,
  UserX,
  UserCheck,
  KeyRound,
} from 'lucide-react'
import Link from 'next/link'

interface UserRow {
  id: string
  name: string
  email: string
  role: string
  is_active: boolean
  created_at: string
}

export default function UsersPage() {
  const { isAdmin, isLoading: sessionLoading } = useSession()
  const [users, setUsers] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [addOpen, setAddOpen] = useState(false)
  const [addLoading, setAddLoading] = useState(false)
  const [addForm, setAddForm] = useState({
    name: '',
    email: '',
    password: '',
    role: 'operator',
  })
  const [addFormError, setAddFormError] = useState('')

  const [editOpen, setEditOpen] = useState(false)
  const [editLoading, setEditLoading] = useState(false)
  const [editUser, setEditUser] = useState<UserRow | null>(null)
  const [editRole, setEditRole] = useState('operator')
  const [editPassword, setEditPassword] = useState('')
  const [editPasswordConfirm, setEditPasswordConfirm] = useState('')
  const [editFormError, setEditFormError] = useState('')

  const fetchUsers = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/users')
      if (res.status === 403) {
        setError('You do not have permission to view users.')
        setUsers([])
        return
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to fetch users')
      }
      const data = await res.json()
      setUsers(data.data || [])
    } catch (err: any) {
      setError(err.message || 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchUsers()
  }, [fetchUsers])

  const handleAddUser = async () => {
    setAddFormError('')
    if (!addForm.name || !addForm.email || !addForm.password) {
      setAddFormError('All fields are required.')
      return
    }
    setAddLoading(true)
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(addForm),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || 'Failed to create user')
      }
      setAddOpen(false)
      setAddForm({ name: '', email: '', password: '', role: 'operator' })
      await fetchUsers()
    } catch (err: any) {
      setAddFormError(err.message || 'Failed to create user')
    } finally {
      setAddLoading(false)
    }
  }

  const openEditModal = (user: UserRow) => {
    setEditUser(user)
    setEditRole(user.role)
    setEditPassword('')
    setEditPasswordConfirm('')
    setEditFormError('')
    setEditOpen(true)
  }

  const handleUpdateRole = async () => {
    if (!editUser) return
    setEditFormError('')
    if (editPassword && editPassword !== editPasswordConfirm) {
      setEditFormError('Passwords do not match.')
      return
    }
    setEditLoading(true)
    try {
      const res = await fetch(`/api/users/${editUser.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role: editRole,
          ...(editPassword ? { password: editPassword } : {}),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update user')
      }
      setEditOpen(false)
      setEditUser(null)
      setEditPassword('')
      setEditPasswordConfirm('')
      await fetchUsers()
    } catch (err: any) {
      setError(err.message || 'Failed to update user')
    } finally {
      setEditLoading(false)
    }
  }

  const handleToggleActive = async (user: UserRow) => {
    try {
      const res = await fetch(`/api/users/${user.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !user.is_active }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update user')
      }
      await fetchUsers()
    } catch (err: any) {
      setError(err.message || 'Failed to update user')
    }
  }

  if (sessionLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-[#0EA5E9]" />
      </div>
    )
  }

  if (!isAdmin) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-8">
        <AlertTriangle className="h-12 w-12 text-[#EF4444]" />
        <h1 className="mt-4 text-xl font-semibold text-[#1E293B]">
          Access Denied
        </h1>
        <p className="mt-2 text-[#64748B]">
          Only administrators can manage users.
        </p>
      </div>
    )
  }

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/settings"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[#64748B] transition-colors hover:bg-[#E2E8F0] hover:text-[#1E293B]"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-[#1E293B]">
              User Management
            </h1>
            <p className="mt-1 text-[#64748B]">
              Manage user accounts, roles, and activation status.
            </p>
          </div>
        </div>
        <Button onClick={() => setAddOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add User
        </Button>
      </div>

      {error && (
        <div className="mb-6 flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-600">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="rounded-xl border border-[#E2E8F0] bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <Users className="h-5 w-5 text-[#0EA5E9]" />
          <h2 className="text-lg font-semibold text-[#1E293B]">Users</h2>
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-[#0EA5E9]" />
          </div>
        ) : users.length === 0 ? (
          <p className="py-8 text-center text-[#94A3B8]">No users found.</p>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableHeader>Name</TableHeader>
                <TableHeader>Email</TableHeader>
                <TableHeader>Role</TableHeader>
                <TableHeader>Status</TableHeader>
                <TableHeader>Created</TableHeader>
                <TableHeader className="text-right">Actions</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">{user.name}</TableCell>
                  <TableCell>{user.email}</TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        user.role === 'admin'
                          ? 'bg-purple-100 text-purple-700'
                          : user.role === 'supervisor'
                            ? 'bg-blue-100 text-blue-700'
                            : 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {user.role}
                    </span>
                  </TableCell>
                  <TableCell>
                    {user.is_active ? (
                      <Badge variant="success">Active</Badge>
                    ) : (
                      <Badge variant="danger">Inactive</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {new Date(user.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => openEditModal(user)}
                        className="flex h-8 w-8 items-center justify-center rounded-lg text-[#64748B] transition-colors hover:bg-[#E2E8F0] hover:text-[#1E293B]"
                        title="Edit role"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleToggleActive(user)}
                        className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
                          user.is_active
                            ? 'text-[#EF4444] hover:bg-red-50'
                            : 'text-[#22C55E] hover:bg-green-50'
                        }`}
                        title={user.is_active ? 'Deactivate' : 'Activate'}
                      >
                        {user.is_active ? (
                          <UserX className="h-4 w-4" />
                        ) : (
                          <UserCheck className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <Modal
        open={addOpen}
        onClose={() => {
          setAddOpen(false)
          setAddFormError('')
        }}
        title="Add User"
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setAddOpen(false)
                setAddFormError('')
              }}
            >
              Cancel
            </Button>
            <Button loading={addLoading} onClick={handleAddUser}>
              Create User
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="Name"
            value={addForm.name}
            onChange={(e) =>
              setAddForm((prev) => ({ ...prev, name: e.target.value }))
            }
            placeholder="Full name"
          />
          <Input
            label="Email"
            type="email"
            value={addForm.email}
            onChange={(e) =>
              setAddForm((prev) => ({ ...prev, email: e.target.value }))
            }
            placeholder="user@example.com"
          />
          <Input
            label="Password"
            type="password"
            value={addForm.password}
            onChange={(e) =>
              setAddForm((prev) => ({ ...prev, password: e.target.value }))
            }
            placeholder="••••••••"
          />
          <div>
            <label className="mb-1 block text-sm font-medium text-[#1E293B]">
              Role
            </label>
            <select
              value={addForm.role}
              onChange={(e) =>
                setAddForm((prev) => ({ ...prev, role: e.target.value }))
              }
              className="block w-full rounded-lg border border-[#E2E8F0] bg-white px-3 py-2 text-sm text-[#1E293B] focus:border-[#0EA5E9] focus:outline-none focus:ring-2 focus:ring-[#0EA5E9]/20"
            >
              <option value="operator">Operator</option>
              <option value="supervisor">Supervisor</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          {addFormError && (
            <p className="text-sm text-[#EF4444]">{addFormError}</p>
          )}
        </div>
      </Modal>

      <Modal
        open={editOpen}
        onClose={() => {
          setEditOpen(false)
          setEditUser(null)
          setEditPassword('')
          setEditPasswordConfirm('')
          setEditFormError('')
        }}
        title={`Edit User: ${editUser?.name}`}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setEditOpen(false)
                setEditUser(null)
                setEditPassword('')
                setEditPasswordConfirm('')
                setEditFormError('')
              }}
            >
              Cancel
            </Button>
            <Button loading={editLoading} onClick={handleUpdateRole}>
              Save Changes
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-[#1E293B]">
              Role
            </label>
            <select
              value={editRole}
              onChange={(e) => setEditRole(e.target.value)}
              className="block w-full rounded-lg border border-[#E2E8F0] bg-white px-3 py-2 text-sm text-[#1E293B] focus:border-[#0EA5E9] focus:outline-none focus:ring-2 focus:ring-[#0EA5E9]/20"
            >
              <option value="operator">Operator</option>
              <option value="supervisor">Supervisor</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div className="border-t border-[#E2E8F0] pt-4">
            <div className="mb-2 flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-[#64748B]" />
              <p className="text-sm font-medium text-[#1E293B]">Change password</p>
            </div>
            {editUser?.role === 'admin' ? (
              <p className="text-sm text-[#64748B]">
                Administrator passwords can only be changed by the administrator themselves.
              </p>
            ) : (
              <div className="space-y-3">
                <Input
                  label="New password"
                  type="password"
                  value={editPassword}
                  onChange={(e) => setEditPassword(e.target.value)}
                  placeholder="Leave blank to keep current password"
                />
                <Input
                  label="Confirm new password"
                  type="password"
                  value={editPasswordConfirm}
                  onChange={(e) => setEditPasswordConfirm(e.target.value)}
                  placeholder="Repeat new password"
                />
              </div>
            )}
          </div>
          {editFormError && <p className="text-sm text-[#EF4444]">{editFormError}</p>}
        </div>
      </Modal>
    </div>
  )
}
