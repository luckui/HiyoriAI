import { createReadStream } from 'fs';
import { readdir, stat } from 'fs/promises';
import { homedir } from 'os';
import { join, normalize } from 'path';
import { createInterface } from 'readline';

export interface CodexSessionCandidate {
  id: string;
  cwd?: string;
  file: string;
  updatedAt: number;
}

interface SessionMetaRecord {
  type?: string;
  payload?: {
    id?: string;
    cwd?: string;
  };
}

export async function listCodexSessionCandidates(options: {
  cwd?: string;
  limit?: number;
} = {}): Promise<CodexSessionCandidate[]> {
  const root = join(homedir(), '.codex', 'sessions');
  const files = await listJsonlFiles(root).catch(() => []);
  const sorted = files
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 100);
  const cwd = options.cwd ? normalize(options.cwd) : undefined;
  const candidates: CodexSessionCandidate[] = [];

  for (const file of sorted) {
    const meta = await readSessionMeta(file.path);
    if (!meta?.id) continue;
    if (cwd && normalize(meta.cwd ?? '') !== cwd) continue;
    candidates.push({
      id: meta.id,
      cwd: meta.cwd,
      file: file.path,
      updatedAt: file.updatedAt,
    });
    if (candidates.length >= (options.limit ?? 5)) break;
  }

  return candidates;
}

async function listJsonlFiles(dir: string): Promise<Array<{ path: string; updatedAt: number }>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: Array<{ path: string; updatedAt: number }> = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listJsonlFiles(fullPath));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const info = await stat(fullPath);
    files.push({ path: fullPath, updatedAt: info.mtimeMs });
  }

  return files;
}

async function readSessionMeta(file: string): Promise<{ id: string; cwd?: string } | undefined> {
  const rl = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      if (!line.includes('"session_meta"')) continue;
      const record = JSON.parse(line) as SessionMetaRecord;
      if (record.type !== 'session_meta' || !record.payload?.id) return undefined;
      return { id: record.payload.id, cwd: record.payload.cwd };
    }
  } catch {
    return undefined;
  } finally {
    rl.close();
  }

  return undefined;
}
