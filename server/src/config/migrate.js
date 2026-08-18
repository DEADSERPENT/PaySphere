#!/usr/bin/env node
/**
 * Minimal, dependency-free migration runner. Applies every .up.sql file in
 * ./migrations that hasn't already been recorded in schema_migrations, in
 * filename order. `node migrate.js down` reverts the most recently applied
 * migration using its paired .down.sql file.
 */
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const env = require('./env');

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

function listMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.up.sql'))
    .sort()
    .map((f) => f.replace(/\.up\.sql$/, ''));
}

async function up(client) {
  await ensureMigrationsTable(client);
  const { rows } = await client.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  for (const name of listMigrations()) {
    if (applied.has(name)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, `${name}.up.sql`), 'utf8');
    console.log(`Applying migration: ${name}`);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }
  console.log('Migrations up to date.');
}

async function down(client) {
  await ensureMigrationsTable(client);
  const { rows } = await client.query(
    'SELECT name FROM schema_migrations ORDER BY applied_at DESC LIMIT 1'
  );
  if (rows.length === 0) {
    console.log('No migrations to revert.');
    return;
  }
  const name = rows[0].name;
  const downFile = path.join(MIGRATIONS_DIR, `${name}.down.sql`);
  if (!fs.existsSync(downFile)) {
    throw new Error(`No down migration found for ${name}`);
  }
  const sql = fs.readFileSync(downFile, 'utf8');
  console.log(`Reverting migration: ${name}`);
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('DELETE FROM schema_migrations WHERE name = $1', [name]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function main() {
  const direction = process.argv[2] || 'up';
  const pool = new Pool({ connectionString: env.databaseUrl });
  const client = await pool.connect();
  try {
    if (direction === 'up') await up(client);
    else if (direction === 'down') await down(client);
    else throw new Error(`Unknown migration direction: ${direction}`);
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { up, down, listMigrations };
