import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { parse } from 'csv-parse';
import yauzl from 'yauzl';

export type Row = Record<string, string>;

/** A GTFS dataset on disk: a .zip file or an extracted directory. */
export interface GtfsSource {
  path: string;
}

export const GTFS_FILES = [
  'agency.txt',
  'stops.txt',
  'routes.txt',
  'trips.txt',
  'stop_times.txt',
  'calendar.txt',
  'calendar_dates.txt',
  'transfers.txt',
  'fare_attributes.txt',
  'fare_rules.txt',
  'feed_info.txt',
  'attributions.txt',
] as const;

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

function openZipEntry(zipPath: string, name: string): Promise<Readable | null> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error(`Cannot open ${zipPath}`));
      let found = false;
      zip.on('entry', (entry: yauzl.Entry) => {
        // Accept files at the root or inside a single top-level folder.
        const base = entry.fileName.split('/').pop();
        if (!found && base === name && !entry.fileName.endsWith('/')) {
          found = true;
          zip.openReadStream(entry, (e, stream) => {
            if (e || !stream) return reject(e ?? new Error(`Cannot read ${name}`));
            resolve(stream);
          });
        } else {
          zip.readEntry();
        }
      });
      zip.on('end', () => {
        if (!found) resolve(null);
      });
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

export async function hasFile(src: GtfsSource, name: string): Promise<boolean> {
  if (isDirectory(src.path)) return existsSync(join(src.path, name));
  const s = await openZipEntry(src.path, name);
  if (s) s.destroy();
  return s !== null;
}

/** Streams the rows of one GTFS table. Missing optional files yield nothing. */
export async function* readTable(src: GtfsSource, name: string): AsyncGenerator<Row> {
  let stream: Readable | null;
  if (isDirectory(src.path)) {
    const p = join(src.path, name);
    stream = existsSync(p) ? createReadStream(p) : null;
  } else {
    stream = await openZipEntry(src.path, name);
  }
  if (!stream) return;
  const parser = stream.pipe(
    parse({
      columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      trim: true,
    }),
  );
  for await (const record of parser) yield record as Row;
}

export async function readAll(src: GtfsSource, name: string): Promise<Row[]> {
  const out: Row[] = [];
  for await (const r of readTable(src, name)) out.push(r);
  return out;
}
