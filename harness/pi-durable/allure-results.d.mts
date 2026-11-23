export function readAllureResults(room: string): {
  verdicts: { id: string; verdict: string; evidence: string }[];
  surprises: {
    item: string;
    observation: string;
    evidence_file: string;
  }[];
  results: unknown[];
  pass: number;
  allureSha256: string;
};
