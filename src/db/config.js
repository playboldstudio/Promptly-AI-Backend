import { Sequelize } from 'sequelize';
import { env } from '../config/env.js';

/**
 * Sequelize instance — the single connection pool for the whole app.
 *
 * The connection string is a full postgres:// URL from .env (Neon/Supabase/RDS).
 * `ssl` is only applied when the URL requests it (sslmode=require) so local dev
 * without SSL still works.
 */
const ssl = /[?&]sslmode=require/.test(env.DATABASE_URL);

export const sequelize = new Sequelize(env.DATABASE_URL, {
  dialect: 'postgres',
  logging: env.NODE_ENV === 'development' ? console.log : false,
  define: {
    underscored: true, // map JS camelCase → snake_case columns, timestamps included
    freezeTableName: false,
  },
  dialectOptions: ssl ? { ssl: { rejectUnauthorized: false } } : {},
});

/**
 * Lightweight connectivity check used by /health and server boot.
 * Returns true when the pool can run `SELECT 1`.
 */
export async function pingDb() {
  try {
    await sequelize.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
