// contracts/schema.sql → the first Drizzle migration. The contract's statements, unchanged, with Drizzle's
// statement breakpoints between them; its PRAGMA is left out (a migration runs in a transaction, where
// foreign_keys cannot change; src/db/open.ts turns it on for every connection).
export function schemaToMigration(schemaSql: string): string {
  const statements: string[] = [];
  let current: string[] = [];
  for (const line of schemaSql.split('\n')) {
    current.push(line);
    const code = line.replace(/--.*$/, '').trimEnd();
    if (code.endsWith(';')) {
      statements.push(current.join('\n').trim());
      current = [];
    }
  }
  const rest = current.join('\n').trim();
  if (rest.replace(/--.*$/gm, '').trim()) throw new Error('schema.sql ends with an unterminated statement');
  return statements
    .filter((s) => !/^(--[^\n]*\n)*\s*PRAGMA\b/i.test(s))
    .join('\n--> statement-breakpoint\n') + '\n';
}
