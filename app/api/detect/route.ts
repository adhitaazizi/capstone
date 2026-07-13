import { NextRequest, NextResponse } from 'next/server'

export interface Detection {
  x: number
  y: number
  width: number
  height: number
  confidence: number
  class: string
}

const loadedLocalModels = new Set<string>()
const modelLoadFailedAt = new Map<string, number>()
const MODEL_LOAD_RETRY_MS = 60_000

export async function POST(req: NextRequest) {
  const mockCountEnv = process.env.MOCK_DETECTION_COUNT
  if (mockCountEnv) {
    const n = Math.max(0, parseInt(mockCountEnv, 10) || 0)
    const detections: Detection[] = Array.from({ length: n }, (_, i) => ({
      x: 64 + i * 64,
      y: 90,
      width: 44,
      height: 44,
      confidence: 0.92,
      class: 'spindle',
    }))
    return NextResponse.json({ detections, count: n, status: 'ok' })
  }

  const apiKey = process.env.ROBOFLOW_API_KEY
  const modelProject = process.env.ROBOFLOW_MODEL_PROJECT
  const modelVersion = process.env.ROBOFLOW_MODEL_VERSION
  const modelApiUrl = (process.env.ROBOFLOW_MODEL_API_URL || 'https://detect.roboflow.com').replace(/\/$/, '')
  const workspace = process.env.ROBOFLOW_WORKSPACE
  const workflow = process.env.ROBOFLOW_WORKFLOW
  const workflowApiUrl = (process.env.ROBOFLOW_API_URL || 'https://serverless.roboflow.com').replace(/\/$/, '')
  const hasDirectModel = Boolean(modelProject && modelVersion)
  const hasWorkflow = Boolean(workspace && workflow)

  if (!apiKey || (!hasDirectModel && !hasWorkflow)) {
    return NextResponse.json({
      detections: [],
      count: 0,
      status: 'not_configured',
      hint: 'Set ROBOFLOW_API_KEY and either model or workflow settings in .env',
    })
  }

  let image: string
  try {
    const body = await req.json()
    image = body.image
    if (typeof image !== 'string' || !image) {
      return NextResponse.json({ error: 'missing image' }, { status: 400 })
    }
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }

  const modelId = `${modelProject}/${modelVersion}`
  const useLocalInference =
    modelApiUrl.includes('localhost') ||
    modelApiUrl.includes('127.0.0.1') ||
    modelApiUrl.includes('host.docker.internal')
  const endpoint = useLocalInference
    ? `${modelApiUrl}/infer/object_detection`
    : hasDirectModel
      ? `${modelApiUrl}/${modelId}?api_key=${encodeURIComponent(apiKey)}&confidence=40&overlap=30`
      : `${workflowApiUrl}/${workspace}/workflows/${workflow}`

  try {
    if (useLocalInference && !loadedLocalModels.has(modelId)) {
      const lastFailed = modelLoadFailedAt.get(modelId) ?? 0
      if (Date.now() - lastFailed < MODEL_LOAD_RETRY_MS) {
        return NextResponse.json({ detections: [], count: 0, status: 'model_loading' })
      }

      const loadResponse = await fetch(`${modelApiUrl}/model/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          model_id: modelId,
        }),
        signal: AbortSignal.timeout(30000),
      })

      if (!loadResponse.ok) {
        const text = await loadResponse.text()
        console.error('[detect] Roboflow local model load error', loadResponse.status, text)
        modelLoadFailedAt.set(modelId, Date.now())
        return NextResponse.json(
          { detections: [], count: 0, status: 'error', errorCode: 'roboflow_model_load_error', detail: text },
          { status: loadResponse.status }
        )
      }
      loadedLocalModels.add(modelId)
      modelLoadFailedAt.delete(modelId)
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        useLocalInference
          ? {
              api_key: apiKey,
              model_id: modelId,
              image: { type: 'base64', value: image },
            }
          : hasDirectModel
            ? {
                api_key: apiKey,
                image: { type: 'base64', value: image },
              }
            : {
                api_key: apiKey,
                inputs: { image: { type: 'base64', value: image } },
              }
      ),
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) {
      const text = await res.text()
      console.error('[detect] Roboflow HTTP error', res.status, text)
      const errorCode = text.includes('credit_cap_exceeded')
        ? 'credit_cap_exceeded'
        : 'roboflow_http_error'
      return NextResponse.json(
        { detections: [], count: 0, status: 'error', errorCode, detail: text },
        { status: res.status }
      )
    }

    const data = await res.json()

    // Direct Model API returns predictions at the root; Workflows use outputs[0].
    const output = useLocalInference
      ? data
      : hasDirectModel
        ? data
        : (data?.outputs?.[0] ?? {})

    // predictions can be nested ({ predictions: [...] }) or a flat array
    const rawPredictions =
      output?.predictions?.predictions ??
      output?.predictions ??
      []

    const detections: Detection[] = Array.isArray(rawPredictions)
      ? rawPredictions.map((p: Record<string, unknown>) => ({
          x: Number(p.x ?? 0),
          y: Number(p.y ?? 0),
          width: Number(p.width ?? 0),
          height: Number(p.height ?? 0),
          confidence: Number(p.confidence ?? 0),
          class: String(p.class ?? 'object'),
        }))
      : []

    const count = Number(output?.count_objects ?? detections.length)

    console.log(`[detect] backend=${hasDirectModel ? 'model' : 'workflow'} model=${hasDirectModel ? modelId : workflow} detections=${detections.length} count=${count}`)

    return NextResponse.json({ detections, count, status: 'ok' })
  } catch (err) {
    console.error('[detect] fetch failed', err)
    return NextResponse.json({ detections: [], count: 0, status: 'error' })
  }
}
