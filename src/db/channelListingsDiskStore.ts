/**
 * Mapping (channel_listings) trên đĩa hosting — data/channel_listings.json
 * Dùng cùng PRODUCTS_STORAGE=disk để tránh ghi Mongo Atlas (dễ đầy 512MB).
 */
import fs from "fs";
import path from "path";

let appRootResolved = "";
let listingsCache: { mtimeMs: number; listings: any[] } | null = null;
let writeChain: Promise<void> = Promise.resolve();

export function setChannelListingsDiskAppRoot(appRoot: string): void {
  appRootResolved = String(appRoot || "").trim();
}

function resolveAppRoot(): string {
  if (appRootResolved) return appRootResolved;
  return process.cwd();
}

export function getChannelListingsDiskPath(): string {
  return path.join(resolveAppRoot(), "data", "channel_listings.json");
}

function ensureDataDir(): void {
  const dir = path.dirname(getChannelListingsDiskPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normalizeListing(row: any): any | null {
  if (!row || typeof row !== "object") return null;
  const id = String(row.id || "").trim();
  if (!id) return null;
  return { ...row, id };
}

export function readChannelListingsFromDisk(): any[] {
  const file = getChannelListingsDiskPath();
  if (!fs.existsSync(file)) {
    listingsCache = { mtimeMs: 0, listings: [] };
    return [];
  }
  const st = fs.statSync(file);
  if (listingsCache && listingsCache.mtimeMs === st.mtimeMs) {
    return listingsCache.listings;
  }
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    const listings = (Array.isArray(parsed) ? parsed : [])
      .map(normalizeListing)
      .filter(Boolean) as any[];
    listingsCache = { mtimeMs: st.mtimeMs, listings };
    return listings;
  } catch (err: any) {
    console.error(
      "[Listings Disk] Đọc channel_listings.json thất bại:",
      err?.message || err,
    );
    throw err instanceof Error ? err : new Error(String(err));
  }
}

function writeChannelListingsToDiskSync(listings: any[]): void {
  ensureDataDir();
  const file = getChannelListingsDiskPath();
  const list = (Array.isArray(listings) ? listings : [])
    .map(normalizeListing)
    .filter(Boolean) as any[];
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(list), "utf-8");
  fs.renameSync(tmp, file);
  try {
    const st = fs.statSync(file);
    listingsCache = { mtimeMs: st.mtimeMs, listings: list };
  } catch {
    listingsCache = { mtimeMs: Date.now(), listings: list };
  }
  console.log(`[Listings Disk] WRITE OK — path=${file} count=${list.length}`);
}

export async function saveChannelListingsToDisk(listings: any[]): Promise<void> {
  const run = writeChain.then(() => {
    writeChannelListingsToDiskSync(listings);
  });
  writeChain = run.catch(() => undefined);
  await run;
}

export async function upsertChannelListingsToDisk(rows: any[]): Promise<number> {
  const incoming = (Array.isArray(rows) ? rows : [])
    .map(normalizeListing)
    .filter(Boolean) as any[];
  if (incoming.length === 0) return 0;
  const current = readChannelListingsFromDisk();
  const byId = new Map(current.map((r) => [String(r.id), r]));
  for (const row of incoming) {
    byId.set(String(row.id), { ...byId.get(String(row.id)), ...row, id: row.id });
  }
  await saveChannelListingsToDisk([...byId.values()]);
  return incoming.length;
}

export async function upsertChannelListingToDisk(row: any): Promise<any> {
  const safe = normalizeListing(row);
  if (!safe) throw new Error("upsertChannelListing(disk): thiếu id");
  await upsertChannelListingsToDisk([safe]);
  return safe;
}

export function countChannelListingsOnDisk(): number {
  return readChannelListingsFromDisk().length;
}

export async function deleteAllChannelListingsFromDisk(): Promise<void> {
  await saveChannelListingsToDisk([]);
}
