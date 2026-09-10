export interface ActivePrompt {
  version: number;
  text: string;
}

export interface PromptVersion {
  id: number;
  version: number;
  text: string;
  active: boolean;
  createdAt: string | null;
}

interface StoredPromptVersion {
  version: number;
  text: string;
  createdAt: string;
}

const ACTIVE_PROMPT_KEY = "copywrite_prompt:active";
const PROMPT_VERSION_PREFIX = "copywrite_prompt:v:";

/** Get the currently active copywrite prompt, or null if none exists */
export async function getActivePrompt(
  kv: KVNamespace,
): Promise<ActivePrompt | null> {
  try {
    return await kv.get<ActivePrompt>(ACTIVE_PROMPT_KEY, "json");
  } catch (err) {
    console.error("Failed to fetch active prompt:", err);
    return null; // Graceful fallback: caller uses hardcoded default
  }
}

/** List all prompt versions, newest first */
export async function listVersions(
  kv: KVNamespace,
): Promise<PromptVersion[]> {
  try {
    const [active, list] = await Promise.all([
      getActivePrompt(kv),
      kv.list({ prefix: PROMPT_VERSION_PREFIX }),
    ]);

    const versions: PromptVersion[] = [];
    for (const key of list.keys || []) {
      try {
        const row = await kv.get<StoredPromptVersion>(key.name, "json");
        if (!row) continue;

        versions.push({
          id: row.version,
          version: row.version,
          text: row.text,
          active: row.version === active?.version,
          createdAt: row.createdAt || null,
        });
      } catch (_) {
        // skip corrupt entries
      }
    }

    return versions.sort((a, b) => b.version - a.version);
  } catch (err) {
    console.error("Failed to list prompt versions:", err);
    return [];
  }
}

/**
 * Create a new prompt version.
 * - Determines next version number from existing rows
 * - Stores the immutable version record
 * - Points the active prompt key at the new version
 * - Returns the new version number
 */
export async function createPromptVersion(
  kv: KVNamespace,
  text: string,
): Promise<ActivePrompt> {
  const existing = await listVersions(kv);
  const nextVersion = existing.length > 0
    ? Math.max(...existing.map((v) => v.version)) + 1
    : 1;

  const active = {
    version: nextVersion,
    text,
  };
  const versionRecord: StoredPromptVersion = {
    ...active,
    createdAt: new Date().toISOString(),
  };

  await kv.put(`${PROMPT_VERSION_PREFIX}${nextVersion}`, JSON.stringify(versionRecord));
  await kv.put(ACTIVE_PROMPT_KEY, JSON.stringify(active));

  return active;
}
