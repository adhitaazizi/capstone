import { betterAuth } from 'better-auth'
import { nextCookies } from 'better-auth/next-js'
import { Pool } from 'pg'

export const auth = betterAuth({
  database: new Pool({ connectionString: process.env.DATABASE_URL }),
  plugins: [nextCookies()],
  session: {
    expiresIn: 60 * 60 * 8,
    updateAge: 60 * 60,
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },
  user: {
    additionalFields: {
      role: {
        type: 'string',
        required: true,
        defaultValue: 'operator',
        input: false,
      },
      is_active: {
        type: 'boolean',
        required: true,
        defaultValue: true,
        input: false,
      },
    },
  },
})
