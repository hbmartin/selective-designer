export declare class TrustedToolError extends Error {
  constructor(message: string);
}

export declare const resolveTrustedTool: (toolName: string) => string;

export declare const resolveTrustedProjectBin: (
  toolName: string,
  cwd?: string
) => string;
