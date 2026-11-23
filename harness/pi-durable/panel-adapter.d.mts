export function runDurablePanel(args: Record<string, unknown>): Promise<unknown>;
export function runDurablePanelReport(args: Record<string, unknown>): Promise<{
  out: string;
  reconciled?: boolean;
  summary: { panel_outcome: string };
}>;
