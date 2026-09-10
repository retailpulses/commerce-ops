import { useState, useCallback, useEffect } from "react";
import { getCopywritePrompt, updateCopywritePrompt } from "../api/client";
import type { PromptVersion } from "../types/inquiry";

export function usePrompt() {
  const [promptVersion, setPromptVersion] = useState(0);
  const [versions, setVersions] = useState<PromptVersion[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await getCopywritePrompt();
      setPromptVersion(data.active.version);
      setVersions(data.versions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load prompt");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const save = useCallback(async (text: string) => {
    setError(null);
    try {
      const data = await updateCopywritePrompt(text);
      setPromptVersion(data.active.version);
      setVersions(data.versions);
      return data.active.version;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save prompt");
      return null;
    }
  }, []);

  return {
    promptVersion,
    versions,
    isLoading,
    error,
    fetch,
    save,
  };
}
