'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession } from '@/hooks/use-session'
import Button from '@/components/ui/button'
import Badge from '@/components/ui/badge'
import {
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeader,
  TableCell,
} from '@/components/ui/table'
import {
  Cpu,
  Rocket,
  AlertTriangle,
  Loader2,
  ArrowLeft,
} from 'lucide-react'
import Link from 'next/link'

interface DetectionModel {
  model_id: number
  model_name: string
  version: string
  architecture: string
  accuracy: number | null
  mlflow_run_id: string | null
  is_active: boolean
  deployed_at: string | null
}

export default function ModelsPage() {
  const { isAdmin, isLoading: sessionLoading } = useSession()
  const [models, setModels] = useState<DetectionModel[]>([])
  const [loading, setLoading] = useState(false)
  const [deployLoadingId, setDeployLoadingId] = useState<number | null>(null)
  const [error, setError] = useState('')

  const fetchModels = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/models')
      if (res.status === 403) {
        setError('You do not have permission to view models.')
        setModels([])
        return
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to fetch models')
      }
      const data = await res.json()
      setModels(data.data || [])
    } catch (err: any) {
      setError(err.message || 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchModels()
  }, [fetchModels])

  const handleDeploy = async (modelId: number) => {
    setDeployLoadingId(modelId)
    try {
      const res = await fetch(`/api/models/${modelId}/deploy`, {
        method: 'POST',
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Deploy failed')
      }
      await fetchModels()
    } catch (err: any) {
      setError(err.message || 'Deploy failed')
    } finally {
      setDeployLoadingId(null)
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
          Only administrators can manage models.
        </p>
      </div>
    )
  }

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center gap-3">
        <Link
          href="/settings"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[#64748B] transition-colors hover:bg-[#E2E8F0] hover:text-[#1E293B]"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-[#1E293B]">
            Model Management
          </h1>
          <p className="mt-1 text-[#64748B]">
            View detection models and deploy the active model.
          </p>
        </div>
      </div>

      {error && (
        <div className="mb-6 flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-600">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="rounded-xl border border-[#E2E8F0] bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <Cpu className="h-5 w-5 text-[#0EA5E9]" />
          <h2 className="text-lg font-semibold text-[#1E293B]">
            Detection Models
          </h2>
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-[#0EA5E9]" />
          </div>
        ) : models.length === 0 ? (
          <p className="py-8 text-center text-[#94A3B8]">
            No detection models found.
          </p>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableHeader>Model Name</TableHeader>
                <TableHeader>Version</TableHeader>
                <TableHeader>Architecture</TableHeader>
                <TableHeader>Accuracy</TableHeader>
                <TableHeader>Status</TableHeader>
                <TableHeader>Deployed At</TableHeader>
                <TableHeader className="text-right">Actions</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {models.map((model) => (
                <TableRow key={model.model_id}>
                  <TableCell className="font-medium">
                    {model.model_name}
                  </TableCell>
                  <TableCell>{model.version}</TableCell>
                  <TableCell>{model.architecture}</TableCell>
                  <TableCell>
                    {model.accuracy != null
                      ? `${(model.accuracy * 100).toFixed(1)}%`
                      : '-'}
                  </TableCell>
                  <TableCell>
                    {model.is_active ? (
                      <Badge variant="success">Active</Badge>
                    ) : (
                      <Badge variant="default">Inactive</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {model.deployed_at
                      ? new Date(model.deployed_at).toLocaleString()
                      : '-'}
                  </TableCell>
                  <TableCell className="text-right">
                    {!model.is_active && (
                      <Button
                        size="sm"
                        loading={deployLoadingId === model.model_id}
                        onClick={() => handleDeploy(model.model_id)}
                      >
                        <Rocket className="mr-1.5 h-3.5 w-3.5" />
                        Deploy
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}
