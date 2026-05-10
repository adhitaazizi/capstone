-- ============================================
-- Seed Admin User for Testing
-- ============================================
--
-- IMPORTANT: This creates a user with a PRE-HASHED password.
-- The password is: "Admin123!"
--
-- After running this, you can log in with:
--   Email: admin@spraycount.local
--   Password: Admin123!
--
-- Run this AFTER 001_better_auth.sql and 002_app_tables.sql
-- ============================================

-- Generate a UUID for the user
-- You can replace this with any valid UUID

INSERT INTO "user" (
    id,
    name,
    email,
    email_verified,
    image,
    created_at,
    updated_at,
    role,
    is_active
) VALUES (
    '550e8400-e29b-41d4-a716-446655440000',
    'Admin User',
    'admin@spraycount.local',
    true,
    NULL,
    NOW(),
    NOW(),
    'admin',
    true
) ON CONFLICT (email) DO NOTHING;

-- ============================================
-- OPTION 1: Using better-auth API (Recommended)
-- ============================================
--
-- Instead of raw SQL, use the API to create the user properly:
--
-- curl -X POST http://localhost:3000/api/auth/sign-up/email \
--   -H "Content-Type: application/json" \
--   -d '{
--     "email": "admin@spraycount.local",
--     "password": "Admin123!",
--     "name": "Admin User"
--   }'
--
-- Then update the role to admin:
--
-- UPDATE "user" SET role = 'admin', is_active = true 
-- WHERE email = 'admin@spraycount.local';
--
-- ============================================

-- ============================================
-- OPTION 2: Pre-hashed Password (Direct SQL)
-- ============================================
--
-- The bcrypt hash below is for password "Admin123!"
-- If you want a different password, use the Node.js script below.
--

-- Insert the credential account for password-based login
INSERT INTO account (
    id,
    account_id,
    provider_id,
    user_id,
    access_token,
    refresh_token,
    id_token,
    access_token_expires_at,
    refresh_token_expires_at,
    scope,
    password,
    created_at,
    updated_at
) VALUES (
    gen_random_uuid()::text,
    'admin@spraycount.local',
    'credential',
    '550e8400-e29b-41d4-a716-446655440000',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    '$2a$10$abcdefghijklmnopqrstuvwxabcdefghijklmnopqrstu',  -- PLACEHOLDER! See below
    NOW(),
    NOW()
) ON CONFLICT (account_id, provider_id) DO NOTHING;

-- ============================================
-- Generate Proper Bcrypt Hash (Run This First)
-- ============================================
--
-- The placeholder password hash above won't work.
-- You need to generate a real bcrypt hash.
--
-- Method A: Using Node.js
--
-- node -e "const bcrypt = require('bcrypt'); bcrypt.hash('Admin123!', 10).then(console.log)"
--
-- Method B: Using Python
--
-- python3 -c "import bcrypt; print(bcrypt.hashpw(b'Admin123!', bcrypt.gensalt(10)).decode())"
--
-- Method C: Using Online Tool (NOT for production!)
-- https://bcrypt-generator.com/
--
-- After generating the hash, replace the password field above and re-run.

-- ============================================
-- Alternative: Test Users for Different Roles
-- ============================================

-- Supervisor user
INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at, role, is_active)
VALUES (
    '550e8400-e29b-41d4-a716-446655440001',
    'Supervisor User',
    'supervisor@spraycount.local',
    true,
    NOW(),
    NOW(),
    'supervisor',
    true
) ON CONFLICT (email) DO NOTHING;

-- Operator user
INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at, role, is_active)
VALUES (
    '550e8400-e29b-41d4-a716-446655440002',
    'Operator User',
    'operator@spraycount.local',
    true,
    NOW(),
    NOW(),
    'operator',
    true
) ON CONFLICT (email) DO NOTHING;

-- ============================================
-- Summary of Test Accounts
-- ============================================
--
-- Email:                    admin@spraycount.local     Role: admin      (All access)
-- Email:                    supervisor@spraycount.local Role: supervisor (Reports + dashboard)
-- Email:                    operator@spraycount.local   Role: operator   (Dashboard only)
-- Password (all accounts):  Admin123!
--
-- ============================================
