const dashboards = [
  {
    title: 'Production Overview',
    description: 'RabbitMQ throughput and queue depth for production flow.',
    uid: 'production-overview',
    height: 500,
  },
  {
    title: 'System Health',
    description: 'RabbitMQ scrape status, resource usage, and broker health.',
    uid: 'system-health',
    height: 500,
  },
]

function getGrafanaUrl() {
  return (
    process.env.NEXT_PUBLIC_GRAFANA_URL ??
    process.env.GRAFANA_URL ??
    'http://localhost:3001'
  ).replace(/\/$/, '')
}

export default function MonitoringPage() {
  const grafanaUrl = getGrafanaUrl()

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#1E293B]">Monitoring</h1>
        <p className="mt-1 text-[#64748B]">
          Embedded Grafana dashboards for production and infrastructure health.
        </p>
      </div>

      <div className="space-y-6">
        {dashboards.map((dashboard) => (
          <section
            key={dashboard.uid}
            className="overflow-hidden rounded-xl border border-[#E2E8F0] bg-white shadow-sm"
          >
            <div className="border-b border-[#E2E8F0] px-5 py-4">
              <h2 className="text-lg font-semibold text-[#1E293B]">
                {dashboard.title}
              </h2>
              <p className="mt-1 text-sm text-[#64748B]">
                {dashboard.description}
              </p>
            </div>
            <iframe
              title={dashboard.title}
              src={`${grafanaUrl}/d/${dashboard.uid}?orgId=1&kiosk&theme=light`}
              height={dashboard.height}
              className="block w-full border-0"
              loading="lazy"
            />
          </section>
        ))}
      </div>
    </div>
  )
}
