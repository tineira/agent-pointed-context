// Types for extension-version.mjs, which apps/dock/vite.config.ts imports (type-checked by apps/dock/tsconfig.web.json).
export declare const EXTENSION_INPUTS: readonly string[];
export declare const UNKNOWN_EXTENSION_VERSION: string;
export declare function isExtensionInput(file: string): boolean;
export declare function extensionRebuildPlan(files: string[]): { rebuild: boolean; install: boolean };
export declare function extensionVersionFor(count: number): string;
export declare function readExtensionVersion(root: string): { version: string; commit: string | null };
