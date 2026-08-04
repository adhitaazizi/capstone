import { INFERENCE_API_KEY } from './constants'

/**
 * Shared-secret check for the machine-to-machine inference routes.
 *
 * These are reached over a public tunnel (Colab cannot see the Docker network),
 * so they cannot rely on a browser session. An unset key fails closed rather
 * than open: silently accepting anonymous writes to the count pipeline would be
 * worse than the routes not working.
 */
export function checkInferenceKey(request: Request): Response | null {
  if (!INFERENCE_API_KEY) {
    console.error('[inference] INFERENCE_API_KEY is not set; refusing the request')
    return Response.json({ error: 'Inference API key not configured' }, { status: 503 })
  }

  const provided = request.headers.get('x-inference-key')
  if (provided !== INFERENCE_API_KEY) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return null
}
