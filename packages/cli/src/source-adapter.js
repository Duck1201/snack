import { createClaudeAdapter } from "./claude-adapter.js";
import { createOpenCodeAdapter } from "./opencode-adapter.js";

/**
 * Choose the reader for a configured source.
 *
 * The one adapter registry there is. Every other caller works through the adapter contract, which
 * is what makes a third client a new adapter rather than a branch spread through the product. It
 * lives here rather than in the command layer so that `doctor` and `sync` can both reach it
 * without importing each other.
 *
 * @param {{adapter: string, database?: string, projects?: string}} source
 */
export function createSourceAdapter(source) {
  return source.adapter === "claude"
    ? createClaudeAdapter({ projectsDirectory: String(source.projects) })
    : createOpenCodeAdapter({ databaseFile: String(source.database) });
}
