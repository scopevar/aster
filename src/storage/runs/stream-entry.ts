export type StreamEntry =
  | { kind: "text"; itemId: string; text: string; replace: boolean }
  | { kind: "tool-output"; itemId: string; delta: string };
