export default function AuthLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <div className="flex min-h-screen w-full">
      <div className="hidden lg:flex lg:w-1/2 flex-col justify-between p-12 bg-gradient-to-br from-[#0EA5E9] to-[#0284C7] text-white">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">SprayCount</h1>
          <p className="mt-2 text-white/80">Automatic Spray Counting System</p>
        </div>
        <div className="space-y-4">
          <p className="text-lg font-medium">
            Industrial edge-AI solution for spray painting line monitoring
          </p>
          <p className="text-sm text-white/70">
            Real-time detection, counting, and analytics for manufacturing quality control.
          </p>
        </div>
      </div>

      <div className="flex w-full lg:w-1/2 items-center justify-center bg-[#F8FAFC] p-6">
        <div className="w-full max-w-md">
          {children}
        </div>
      </div>
    </div>
  )
}
