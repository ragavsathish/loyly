export function prepareBlindReview(args: Record<string, unknown>): void;
export function verifyBlindReviewPacket(args: Record<string, unknown>): {
  packetSha256: string;
};
export function probeBlindAnswer(args: Record<string, unknown>): Promise<unknown>;
export function writeBlindAgentAllure(args: Record<string, unknown>): void;
export function finalVerdictsFromBlindReview(args: Record<string, unknown>): {
  verdicts: unknown[];
  rawAllureSha256?: string;
  reviewSha256?: string;
};
export function readBlindAgentAllure(args: Record<string, unknown>): {
  result: {
    name: string;
    status: string;
    stage: string;
    statusDetails: { message: string };
    steps: { name: string; status: string; stage: string }[];
    attachments: { name: string; type: string; source: string }[];
    labels: { name: string; value: string }[];
  };
  reviewSha256: string;
};
