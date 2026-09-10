import { useState, useCallback } from "react";
import { getTemplates, createTemplate, updateTemplate, deleteTemplate } from "../api/client";
import type { MessageTemplate } from "../types/inquiry";

export function useTemplates() {
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await getTemplates();
      setTemplates(data.templates);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load templates");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const create = useCallback(async (title: string, body: string) => {
    setError(null);
    try {
      const data = await createTemplate(title, body);
      setTemplates((prev) => [data.template, ...prev]);
      return data.template;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create template");
      return null;
    }
  }, []);

  const update = useCallback(async (id: string, title: string, body: string) => {
    setError(null);
    try {
      const data = await updateTemplate(id, title, body);
      setTemplates((prev) =>
        prev.map((t) => (t.id === id ? data.template : t)),
      );
      return data.template;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update template");
      return null;
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    setError(null);
    try {
      await deleteTemplate(id);
      setTemplates((prev) => prev.filter((t) => t.id !== id));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete template");
      return false;
    }
  }, []);

  return {
    templates,
    isLoading,
    error,
    fetch,
    create,
    update,
    remove,
  };
}
