import { useEffect, useState } from "react";
import { getListingOptimization, publishListingOptimization, suggestListingOptimization } from "../../api/client";
import type { ListingOptimizationState } from "../../types/inquiry";

export default function ListingOptimization({ inquiryId, mutationsEnabled }: { inquiryId: number; mutationsEnabled: boolean }) {
  const [state, setState] = useState<ListingOptimizationState | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = async () => {
    setMessage(null);
    try {
      const next = await getListingOptimization(inquiryId);
      setState(next);
      setTitle(next.listing?.title || "");
      setDescription(next.listing?.description || "");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to load listing"); }
  };
  useEffect(() => { void load(); }, [inquiryId]);

  const suggest = async () => {
    setBusy(true); setMessage(null);
    try { const result = await suggestListingOptimization(inquiryId); setTitle(result.title); setDescription(result.description); setMessage("Optimization proposal generated. Review every field before publishing."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Generation failed"); }
    finally { setBusy(false); }
  };
  const publish = async (fields: Array<"title" | "description">) => {
    if (!state?.listing) return;
    const warning = state.listing.scoreTotal === null || state.listing.scoreIsStale || state.listing.scoreTotal < 75
      ? "Quality score is missing, stale, or below the recommended threshold. Publish selected changes anyway?"
      : "Publish the selected changes to this exact listing?";
    if (!window.confirm(warning)) return;
    setBusy(true); setMessage(null);
    try {
      const result = await publishListingOptimization(inquiryId, { fields, title, description, expectedContentRevision: state.listing.contentRevision });
      setMessage(result.warnings?.length ? `Published with warnings: ${result.warnings.join(", ")}` : "Published successfully");
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Publish failed"); }
    finally { setBusy(false); }
  };

  return <section className="rounded-lg border border-gray-200 bg-white p-4">
    <div className="mb-3 flex items-center justify-between gap-3">
      <h3 className="text-sm font-medium text-gray-700">Listing Optimization</h3>
      {state?.listing && <span className="rounded bg-blue-50 px-2 py-1 text-xs text-blue-700">Quality score: {state.listing.scoreTotal ?? "Not scored"}{state.listing.scoreIsStale ? " (stale)" : ""}</span>}
    </div>
    {!state?.listing ? <p className="text-xs text-amber-700">{state?.message || message || "Loading listing…"}</p> : <div className="space-y-3">
      <p className="text-xs text-gray-500">Exact listing: {state.listing.platform} / {state.listing.shopCode} / <span className="notranslate" translate="no">{state.listing.externalListingId}</span></p>
      <label className="block text-xs text-gray-600">Optimized title
        <input value={title} maxLength={130} onChange={(event) => setTitle(event.target.value)} className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
      </label>
      <label className="block text-xs text-gray-600">Optimized description
        <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={7} className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy || !mutationsEnabled} onClick={suggest} className="rounded border border-gray-300 px-3 py-1.5 text-xs">Generate proposal</button>
        <button type="button" disabled={busy || !title.trim()} onClick={() => publish(["title"])} className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white">Publish Title</button>
        <button type="button" disabled={busy || !description.trim()} onClick={() => publish(["description"])} className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white">Publish Description</button>
        <button type="button" disabled={busy || !title.trim() || !description.trim()} onClick={() => publish(["title", "description"])} className="rounded bg-green-600 px-3 py-1.5 text-xs text-white">Publish All</button>
      </div>
      <p className="text-xs text-gray-400">Update to all shops — Future roadmap</p>
      {message && <p className="text-xs text-gray-600">{message}</p>}
    </div>}
  </section>;
}
