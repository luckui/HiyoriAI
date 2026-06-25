import { RuntimeHost } from './runtimeHost';
import { RuntimeRegistry } from './runtimeRegistry';
import { TranscriptMirror } from './transcriptMirror';
import { createFakeRuntimeProvider } from './providers/fake';

export * from './runtimeHost';
export * from './runtimeRegistry';
export * from './transcriptMirror';
export * from './types';

export const runtimeRegistry = new RuntimeRegistry();
runtimeRegistry.register(createFakeRuntimeProvider());

export const runtimeTranscriptMirror = new TranscriptMirror();
export const runtimeHost = new RuntimeHost(runtimeRegistry, runtimeTranscriptMirror);
