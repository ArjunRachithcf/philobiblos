// Writes drizzle/0000_init.sql from contracts/schema.sql. Run: pnpm --filter @shelf/server exec tsx scripts/schema-to-migration.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { schemaToMigration } from '../src/db/contract-sql';

const schema = readFileSync(new URL('../../../contracts/schema.sql', import.meta.url), 'utf8');
writeFileSync(new URL('../drizzle/0000_init.sql', import.meta.url), schemaToMigration(schema));
