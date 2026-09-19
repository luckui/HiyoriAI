import { RuntimeHost } from './runtimeHost';
import { RuntimeRegistry } from './runtimeRegistry';
import { TranscriptMirror } from './transcriptMirror';
import { createCodexRuntimeProvider } from './providers/codex';

export * from './runtimeHost';
export * from './runtimeRegistry';
export * from './transcriptMirror';
export * from './types';

export const runtimeRegistry = new RuntimeRegistry();
runtimeRegistry.register(createCodexRuntimeProvider());

export const runtimeTranscriptMirror = new TranscriptMirror();
export const runtimeHost = new RuntimeHost(runtimeRegistry, runtimeTranscriptMirror);
