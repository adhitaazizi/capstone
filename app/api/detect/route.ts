import { NextRequest, NextResponse } from 'next/server'

export interface Detection {
  x: number
  y: number
  width: number
  height: number
  confidence: number
  class: string
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ROBOFLOW_API_KEY
  const workspace = process.env.ROBOFLOW_WORKSPACE
  const workflow = process.env.ROBOFLOW_WORKFLOW
  const apiUrl = (process.env.ROBOFLOW_API_URL || 'https://serverless.roboflow.com').replace(/\/$/, '')

  if (!apiKey || !workspace || !workflow) {
    return NextResponse.json({
      detections: [],
      count: 0,
      status: 'not_configured',
      hint: 'Set ROBOFLOW_API_KEY, ROBOFLOW_WORKSPACE, ROBOFLOW_WORKFLOW in .env',
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

  const endpoint = `${apiUrl}/${workspace}/workflows/${workflow}`

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        inputs: { image: { type: 'base64', value: image } },
      }),
      signal: AbortSignal.timeout(8000),
    })

    if (!res.ok) {
      const text = await res.text()
      console.error('[detect] Roboflow HTTP error', res.status, text)
      return NextResponse.json({ detections: [], count: 0, status: 'error', detail: text })
    }

    const data = await res.json()

    // Roboflow Workflows: { outputs: [{ predictions: { predictions: [...] }, count_objects: N }] }
    const output = data?.outputs?.[0] ?? {}

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

    console.log(`[detect] endpoint=${endpoint} detections=${detections.length} count=${count}`)

    return NextResponse.json({ detections, count, status: 'ok' })
  } catch (err) {
    console.error('[detect] fetch failed', err)
    return NextResponse.json({ detections: [], count: 0, status: 'error' })
  }
}
