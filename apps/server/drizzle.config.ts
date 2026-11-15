import { defineConfig } from 'drizzle-kit';

// Migrations: drizzle/0000_init.sql is contracts/schema.sql (scripts/schema-to-migration.mjs);
// later ones come from `pnpm db:generate` after a change to src/db/schema.ts and to the contract.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
