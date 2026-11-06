import { z } from "zod";

export const githubRepositorySchema = z
  .string()
  .max(140)
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/);

export type UpdateFeed =
  | { provider: "generic"; url: string; useMultipleRangeRequest: false }
  | { provider: "github"; owner: string; repo: string };

export function parseGitHubUpdateFeed(raw: string) {
  const repository = githubRepositorySchema.safeParse(raw);
  if (!repository.success) return null;
  const slash = repository.data.indexOf("/");
  return {
    provider: "github" as const,
    owner: repository.data.slice(0, slash),
    repo: repository.data.slice(slash + 1),
  };
}
