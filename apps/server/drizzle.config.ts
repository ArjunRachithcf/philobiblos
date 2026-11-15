import { defineConfig } from 'drizzle-kit';

// Migrations: 0000_init.sql was contracts/schema.sql v1, verbatim; later ones come from `pnpm db:generate` after a
// change to the contract and to src/db/schema.ts (test/migrations.contract.test.ts checks all three agree).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
