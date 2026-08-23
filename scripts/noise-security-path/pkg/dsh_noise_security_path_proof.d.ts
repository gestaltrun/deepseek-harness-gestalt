/* tslint:disable */
/* eslint-disable */

import type {
  InitInput as SharedInitInput,
  SyncInitInput as SharedSyncInitInput,
} from '../../../packages/platform/noise-channel/pkg/dsh_noise_channel.js'

/**
 * Run the complete proof and return a stable JSON report.
 */
export function run_proof_json(runtime: string): string;

export type InitInput = SharedInitInput;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly run_proof_json: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = SharedSyncInitInput;

export const initSync: (module: { module: SyncInitInput } | SyncInitInput) => InitOutput
declare const init: (
  moduleOrPath?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>
) => Promise<InitOutput>
export default init
