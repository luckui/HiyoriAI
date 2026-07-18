import { spawn } from 'child_process';
import { createHash } from 'crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, extname, join, resolve } from 'path';
import type { TTSConfig, VoicePresetItem } from './tts.config';

export interface GenieVoiceSource {
  ok: true;
  name: string;
  ckptPath: string;
  pthPath: string;
  referenceAudioPath: string;
}

export interface GenieVoiceSourceError {
  ok: false;
  error: string;
}

export type GenieVoiceSourceResult = GenieVoiceSource | GenieVoiceSourceError;

export interface GenieVoiceImportResult {
  ok: boolean;
  canceled?: boolean;
  voice?: VoicePresetItem;
  detail: string;
  installedDir?: string;
}

const SUPPORTED_AUDIO_EXTS = new Set(['.wav', '.flac', '.ogg', '.aiff', '.aif']);
const REQUIRED_ONNX_FILES = [
  't2s_encoder_fp32.bin',
  't2s_encoder_fp32.onnx',
  't2s_first_stage_decoder_fp32.onnx',
  't2s_shared_fp16.bin',
  't2s_stage_decoder_fp32.onnx',
  'vits_fp16.bin',
  'vits_fp32.onnx',
];

export function detectUnsupportedSovitsModel(fileName: string): string | null {
  const normalized = fileName.toLowerCase();
  if (/\b(v3|v4)\b/.test(normalized) || normalized.includes('lora')) {
    return 'Genie-TTS currently supports GPT-SoVITS V2/V2ProPlus conversion only. V3/V4/LoRA voices are not supported yet.';
  }
  return null;
}

export function normalizeGenieVoiceId(displayName: string): string {
  const ascii = displayName
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (ascii) return ascii.slice(0, 48);

  const hash = createHash('sha1').update(displayName).digest('hex').slice(0, 8);
  return `voice-${hash}`;
}

export function referenceTextFromAudioName(fileName: string): string {
  const stem = basename(fileName, extname(fileName));
  return stem.replace(/^\u3010[^\u3011]+\u3011/, '').trim() || stem.trim();
}

export function buildGenieVoicePreset(input: { voiceId: string; displayName: string }): VoicePresetItem {
  return {
    id: input.voiceId,
    name: input.displayName,
    description: 'Genie-TTS custom voice',
    refAudioFile: 'reference.wav',
  };
}

export function findGenieVoiceSource(sourceDir: string): GenieVoiceSourceResult {
  const root = resolve(sourceDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { ok: false, error: `Voice folder does not exist: ${sourceDir}` };
  }

  const entries = readdirSync(root, { withFileTypes: true });
  const ckpt = entries
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.ckpt'))
    .map(e => join(root, e.name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  const pth = entries
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.pth'))
    .map(e => join(root, e.name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];

  if (!ckpt || !pth) {
    return { ok: false, error: 'Please select a GPT-SoVITS V2/V2ProPlus folder containing one .ckpt and one .pth file.' };
  }

  const unsupported = detectUnsupportedSovitsModel(basename(pth));
  if (unsupported) return { ok: false, error: unsupported };

  const referenceAudio = findFirstReferenceAudio(root);
  if (!referenceAudio) {
    return { ok: false, error: 'No reference audio found. Add a .wav/.flac/.ogg/.aiff file under reference_audios or the voice folder.' };
  }

  return {
    ok: true,
    name: basename(root),
    ckptPath: ckpt,
    pthPath: pth,
    referenceAudioPath: referenceAudio,
  };
}

export function mergeBuiltinTTSProviders(config: TTSConfig, defaults: TTSConfig): TTSConfig {
  const merged: TTSConfig = JSON.parse(JSON.stringify(config));
  for (const [key, codeProv] of Object.entries(defaults.providers)) {
    const uiProv = merged.providers[key];
    if (uiProv) {
      merged.providers[key] = {
        ...codeProv,
        speaker: uiProv.speaker ?? codeProv.speaker,
        language: uiProv.language ?? codeProv.language,
        voicePresets: uiProv.voicePresets ?? codeProv.voicePresets,
      };
    } else {
      merged.providers[key] = JSON.parse(JSON.stringify(codeProv));
    }
  }
  merged.deletedProviders = (merged.deletedProviders ?? []).filter(k => !(k in defaults.providers));
  return merged;
}

export function createGenieImportPaths(voicesRoot: string, voiceId: string, timestamp = Date.now()): {
  installDir: string;
  tempRoot: string;
  tempModels: string;
} {
  const importTmpRoot = join(voicesRoot, '.import-tmp');
  const tempRoot = join(importTmpRoot, `${voiceId}-${timestamp}`);
  return {
    installDir: join(voicesRoot, voiceId),
    tempRoot,
    tempModels: join(tempRoot, 'tts_models'),
  };
}

export async function importGenieVoiceFromFolder(
  sourceDir: string,
  deps: {
    appPath?: string;
    resourcesPath?: string;
    isPackaged?: boolean;
    converterPython?: string;
    onProgress?: (msg: string) => void;
  } = {},
): Promise<GenieVoiceImportResult> {
  const source = findGenieVoiceSource(sourceDir);
  if (!source.ok) return { ok: false, detail: source.error };

  const appPathInfo = resolveAppPaths(deps);
  const serverDir = appPathInfo.isPackaged
    ? join(appPathInfo.resourcesPath, 'tts-server-genie')
    : join(appPathInfo.appPath, 'tts-server-genie');
  const voicesRoot = join(serverDir, 'CharacterModels', 'v2ProPlus');
  const voiceId = uniqueVoiceId(normalizeGenieVoiceId(source.name), voicesRoot);
  const { installDir, tempRoot, tempModels } = createGenieImportPaths(voicesRoot, voiceId);
  const converterScript = join(serverDir, 'convert_voice.py');
  const discoveredGenieSourceDir = findGenieSourceDir(serverDir);
  const genieSourceDir = discoveredGenieSourceDir ?? serverDir;
  const converterPython =
    deps.converterPython
    ?? process.env['GENIE_TTS_CONVERTER_PYTHON']
    ?? (discoveredGenieSourceDir ? 'python' : findGenieVenvPython(serverDir))
    ?? 'python';
  const log = (msg: string) => deps.onProgress?.(msg);

  if (!existsSync(converterScript)) {
    return { ok: false, detail: `Genie converter script is missing: ${converterScript}` };
  }
  mkdirSync(tempModels, { recursive: true });
  log(`Converting Genie voice: ${source.name}`);
  const convert = await runConverter({
    pythonExe: converterPython,
    scriptPath: converterScript,
    ckptPath: source.ckptPath,
    pthPath: source.pthPath,
    outputDir: tempModels,
    serverDir,
    genieSourceDir,
    onProgress: log,
  });
  if (!convert.ok) {
    safeRemoveInside(tempRoot, join(voicesRoot, '.import-tmp'));
    return { ok: false, detail: convert.detail };
  }

  const missing = REQUIRED_ONNX_FILES.filter(name => !existsSync(join(tempModels, name)));
  if (missing.length > 0) {
    safeRemoveInside(tempRoot, join(voicesRoot, '.import-tmp'));
    return { ok: false, detail: `Conversion finished but output is incomplete. Missing: ${missing.join(', ')}` };
  }

  mkdirSync(join(installDir, 'prompt_wav'), { recursive: true });
  mkdirSync(dirname(join(installDir, 'tts_models')), { recursive: true });
  renameSync(tempModels, join(installDir, 'tts_models'));
  copyFileSync(source.referenceAudioPath, join(installDir, 'prompt_wav', 'reference.wav'));
  writeFileSync(
    join(installDir, 'prompt_wav.json'),
    JSON.stringify({
      Normal: {
        wav: 'reference.wav',
        text: referenceTextFromAudioName(source.referenceAudioPath),
      },
    }, null, 2),
    'utf-8',
  );
  safeRemoveInside(tempRoot, join(voicesRoot, '.import-tmp'));

  const voice = buildGenieVoicePreset({ voiceId, displayName: source.name });
  log(`Genie voice imported: ${source.name} (${voiceId})`);
  return {
    ok: true,
    voice,
    installedDir: installDir,
    detail: `Imported Genie voice "${source.name}". Restart Genie-TTS to load the new speaker.`,
  };
}

function findFirstReferenceAudio(root: string): string | null {
  const preferred = join(root, 'reference_audios');
  const searchRoots = existsSync(preferred) ? [preferred, root] : [root];
  for (const searchRoot of searchRoots) {
    const found = walkFiles(searchRoot).find(file => SUPPORTED_AUDIO_EXTS.has(extname(file).toLowerCase()));
    if (found) return found;
  }
  return null;
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function uniqueVoiceId(baseId: string, voicesRoot: string): string {
  if (!existsSync(join(voicesRoot, baseId))) return baseId;
  const suffix = createHash('sha1').update(`${baseId}:${Date.now()}`).digest('hex').slice(0, 6);
  return `${baseId}-${suffix}`;
}

function resolveAppPaths(deps: { appPath?: string; resourcesPath?: string; isPackaged?: boolean }): {
  appPath: string;
  resourcesPath: string;
  isPackaged: boolean;
} {
  if (deps.appPath && deps.resourcesPath && deps.isPackaged !== undefined) {
    return { appPath: deps.appPath, resourcesPath: deps.resourcesPath, isPackaged: deps.isPackaged };
  }
  // Lazy require keeps the pure helpers testable without an Electron runtime.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { app } = require('electron') as typeof import('electron');
  return {
    appPath: deps.appPath ?? app.getAppPath(),
    resourcesPath: deps.resourcesPath ?? process.resourcesPath,
    isPackaged: deps.isPackaged ?? app.isPackaged,
  };
}

function findGenieSourceDir(serverDir: string): string | null {
  const candidates = [
    join(serverDir, '..', '..', 'Genie-TTS-master'),
    join(serverDir, '..', 'Genie-TTS-master'),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'pyproject.toml')) || existsSync(join(dir, 'src', 'genie_tts', '__init__.py'))) {
      return resolve(dir);
    }
  }
  return null;
}

function findGenieVenvPython(serverDir: string): string | null {
  const python = process.platform === 'win32'
    ? join(serverDir, '.venv', 'Scripts', 'python.exe')
    : join(serverDir, '.venv', 'bin', 'python');
  return existsSync(python) ? python : null;
}

function runConverter(args: {
  pythonExe: string;
  scriptPath: string;
  ckptPath: string;
  pthPath: string;
  outputDir: string;
  serverDir: string;
  genieSourceDir: string;
  onProgress?: (msg: string) => void;
}): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(args.pythonExe, [
      args.scriptPath,
      '--ckpt', args.ckptPath,
      '--pth', args.pthPath,
      '--out', args.outputDir,
      '--genie-source', args.genieSourceDir,
    ], {
      cwd: args.serverDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        KMP_DUPLICATE_LIB_OK: 'TRUE',
        GENIE_DATA_DIR: join(args.serverDir, 'GenieData'),
      },
      windowsHide: true,
    });

    let output = '';
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      output += text;
      for (const line of text.split(/\r\n|\r|\n/)) {
        const trimmed = line.trim();
        if (trimmed) args.onProgress?.(trimmed);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (error) => {
      resolvePromise({ ok: false, detail: `Failed to start converter Python: ${error.message}` });
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise({ ok: true, detail: 'Conversion completed' });
      } else {
        resolvePromise({ ok: false, detail: `Genie conversion failed with code ${code}:\n${output.slice(-2000)}` });
      }
    });
  });
}

function safeRemoveInside(target: string, parent: string): void {
  const resolvedTarget = resolve(target);
  const resolvedParent = resolve(parent);
  if (!resolvedTarget.startsWith(resolvedParent)) return;
  try { rmSync(resolvedTarget, { recursive: true, force: true }); } catch { /* ignore */ }
}
