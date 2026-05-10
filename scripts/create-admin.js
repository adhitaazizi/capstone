#!/usr/bin/env node
/**
 * Create Admin User Script
 *
 * Usage:
 *   node scripts/create-admin.js
 *
 * This script creates an admin user with a properly hashed password.
 * Run this after the database migrations are applied.
 */

const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const ADMIN_EMAIL = 'admin@spraycount.local';
const ADMIN_PASSWORD = 'Admin123!';
const ADMIN_NAME = 'Admin User';

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    // Check if user already exists
    const existing = await pool.query(
      'SELECT id FROM "user" WHERE email = $1',
      [ADMIN_EMAIL]
    );

    if (existing.rows.length > 0) {
      console.log('Admin user already exists:', ADMIN_EMAIL);
      console.log('Updating role to admin...');
      await pool.query(
        'UPDATE "user" SET role = $1, is_active = true WHERE email = $2',
        ['admin', ADMIN_EMAIL]
      );
      console.log('Role updated to admin.');
      return;
    }

    // Hash password
    console.log('Hashing password...');
    const hashedPassword = await bcrypt.hash(ADMIN_PASSWORD, 10);

    // Generate UUID
    const userId = crypto.randomUUID();
    const accountId = crypto.randomUUID();

    // Insert user
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at, role, is_active)
       VALUES ($1, $2, $3, true, NOW(), NOW(), 'admin', true)`,
      [userId, ADMIN_NAME, ADMIN_EMAIL]
    );

    // Insert credential account
    await pool.query(
      `INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)
       VALUES ($1, $2, 'credential', $3, $4, NOW(), NOW())`,
      [accountId, ADMIN_EMAIL, userId, hashedPassword]
    );

    console.log('\n✅ Admin user created successfully!');
    console.log('\nLogin credentials:');
    console.log('  Email:', ADMIN_EMAIL);
    console.log('  Password:', ADMIN_PASSWORD);
    console.log('  Role: admin');
    console.log('\nYou can now log in at: http://localhost:3000/login');

  } catch (err) {
    console.error('Error creating admin user:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
