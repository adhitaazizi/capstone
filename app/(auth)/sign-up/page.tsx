"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";

export default function SignUpPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const result = await authClient.signUp.email({
        email,
        password,
        name,
      });

      if (result.error) {
        throw new Error(result.error.message || "Sign up failed");
      }

      toast.success(
        "Account created! You can now log in. If you need admin access, ask an admin to update your role."
      );
      setName("");
      setEmail("");
      setPassword("");
      router.push("/login");
    } catch (err: any) {
      setError(err.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-[#F8FAFC] px-4">
      <div className="w-full max-w-md rounded-xl bg-white p-8 shadow-lg">
        <h1 className="mb-2 text-center text-2xl font-bold text-[#1E293B]">
          Create Account
        </h1>
        <p className="mb-6 text-center text-sm text-[#64748B]">
          SprayCount — Automatic Spray Counting System
        </p>

        {error && (
          <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="name"
              className="mb-1 block text-sm font-medium text-[#1E293B]"
            >
              Full Name
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="w-full rounded-lg border border-[#E2E8F0] px-4 py-2.5 text-sm text-[#1E293B] outline-none transition-colors focus:border-[#0EA5E9] focus:ring-2 focus:ring-[#0EA5E9]/20"
              placeholder="John Doe"
            />
          </div>

          <div>
            <label
              htmlFor="email"
              className="mb-1 block text-sm font-medium text-[#1E293B]"
            >
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full rounded-lg border border-[#E2E8F0] px-4 py-2.5 text-sm text-[#1E293B] outline-none transition-colors focus:border-[#0EA5E9] focus:ring-2 focus:ring-[#0EA5E9]/20"
              placeholder="you@company.com"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="mb-1 block text-sm font-medium text-[#1E293B]"
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              className="w-full rounded-lg border border-[#E2E8F0] px-4 py-2.5 text-sm text-[#1E293B] outline-none transition-colors focus:border-[#0EA5E9] focus:ring-2 focus:ring-[#0EA5E9]/20"
              placeholder="Min. 8 characters"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-[#0EA5E9] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#0284C7] disabled:opacity-50"
          >
            {loading ? "Creating account..." : "Create Account"}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-[#64748B]">
          Already have an account?{" "}
          <Link
            href="/login"
            className="font-medium text-[#0EA5E9] hover:text-[#0284C7]"
          >
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
