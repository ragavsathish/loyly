export function runBlindAgent(args: Record<string, unknown>): Promise<{
  review: Record<string, unknown> & {
    launch_receipt_sha256?: string;
    verdict?: string;
  };
  request?: unknown;
  reconciled?: boolean;
}>;
