import { createSql } from './client';
import { migrate } from './migrate';

const sql = createSql(undefined, { max: 1 });
try {
  const applied = await migrate(sql, (m) => console.log(m));
  console.log(applied.length ? `${applied.length} migration(s) applied` : 'database is up to date');
} finally {
  await sql.end();
}
