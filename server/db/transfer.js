// Copies every table from one database to another (SQLite ⇄ PostgreSQL) in batches.
// Used by `npm run db:push` (local SQLite → cloud Postgres), `npm run db:pull` and by
// `npm run db:seed` when DATABASE_URL points at Postgres.
// Runs with the trigger flags bulk+purge: the copy is a physical replica (versions are copied
// as they are, no new versions are written, and the target may be wiped first).
export async function transfer(source, target, { log = console.log } = {}) {
  await target.migrate();
  const srcTables = new Set(await source.tableNames());
  const tables = (await target.tableNames()).filter((t) => srcTables.has(t) && t !== 'az_meta' && t !== 'az_ctl');
  const counts = {};
  const load = async () => {
    // wipe target first (FKs are deferred on Postgres / disabled on SQLite during the load)
    if (target.dialect === 'pg') await target.exec(`TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')} CASCADE`);
    else for (const t of tables) await target.run(`DELETE FROM ${t}`);
    for (const t of tables) {
      const tcols = new Set((await target.tableColumns(t)).map((c) => c.name));
      const rows = await source.all(`SELECT * FROM ${t}`);
      counts[t] = rows.length;
      if (!rows.length) continue;
      const cols = Object.keys(rows[0]).filter((c) => tcols.has(c));
      const per = Math.max(1, Math.min(400, Math.floor(30000 / cols.length)));
      for (let i = 0; i < rows.length; i += per) {
        const chunk = rows.slice(i, i + per);
        const values = chunk.map(() => `(${cols.map(() => '?').join(',')})`).join(',');
        await target.run(`INSERT INTO ${t} (${cols.join(',')}) VALUES ${values}`, ...chunk.flatMap((r) => cols.map((c) => r[c])));
      }
    }
    if (target.dialect === 'pg') {
      for (const t of ['az_metric_sample', 'az_event', 'az_version']) {
        if (tables.includes(t)) await target.exec(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${t}), 0), 1))`);
      }
    }
  };
  if (target.dialect === 'sqlite') {
    await target.exec('PRAGMA foreign_keys = OFF');
    try { await target.withFlags({ bulk: 1, purge: 1, note: 'bulk transfer' }, load); } finally { await target.exec('PRAGMA foreign_keys = ON'); }
  } else {
    await target.withFlags({ bulk: 1, purge: 1, note: 'bulk transfer' }, load);
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  log(`• Copied ${total} rows across ${Object.keys(counts).length} tables`);
  return counts;
}
