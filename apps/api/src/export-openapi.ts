/** Writes the OpenAPI document to docs/openapi.json (no database connection needed). */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSql } from '@openbus/db';
import { REPO_ROOT } from '@openbus/ingest';
import { loadConfig } from './config';
import { noCache } from './result-cache';
import { buildServer } from './server';

const sql = createSql();
const app = await buildServer({ sql, config: { ...loadConfig(), logLevel: 'silent' }, cache: noCache });
await app.ready();
const file = join(REPO_ROOT, 'docs', 'openapi.json');
writeFileSync(file, JSON.stringify(app.swagger(), null, 2));
console.log(`written ${file}`);
await app.close();
await sql.end();
