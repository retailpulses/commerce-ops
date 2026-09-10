import { useEffect, useMemo, useState } from "react";
import {
  getMainImageContext,
  runMainImageAction,
  type MainImageCandidateResult,
  type MainImageSavedAsset,
  type MainImageSchemaResult,
} from "../../api/client";
import type { MainImageContextState } from "../../types/inquiry";

type ReviewKey = "fidelity" | "color" | "copy";

export default function MainImageOptimization({ inquiryId, mutationsEnabled }: { inquiryId: number; mutationsEnabled: boolean }) {
  const [state, setState] = useState<MainImageContextState | null>(null);
  const [schemaText, setSchemaText] = useState("");
  const [schemaMeta, setSchemaMeta] = useState<MainImageSchemaResult | null>(null);
  const [candidate, setCandidate] = useState<MainImageCandidateResult | null>(null);
  const [saved, setSaved] = useState<MainImageSavedAsset | null>(null);
  const [confirmedEvidence, setConfirmedEvidence] = useState<string[]>([]);
  const [review, setReview] = useState<Record<ReviewKey, boolean>>({ fidelity: false, color: false, copy: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = async () => {
    setMessage(null);
    try { setState(await getMainImageContext(inquiryId)); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Unable to load main-image context"); }
  };

  useEffect(() => {
    setState(null); setSchemaText(""); setSchemaMeta(null); setCandidate(null); setSaved(null);
    setConfirmedEvidence([]); setReview({ fidelity: false, color: false, copy: false });
    void load();
  }, [inquiryId]);

  const contextEvidence = useMemo(
    () => state?.context?.fact_pack.evidence.filter((item) => item.status === "context_only") ?? [],
    [state],
  );
  const verifiedEvidence = useMemo(
    () => state?.context?.fact_pack.evidence.filter((item) => item.status === "verified") ?? [],
    [state],
  );
  const revision = state?.listing?.contentRevision;

  const parseSchema = (): Record<string, unknown> | null => {
    try {
      const value = JSON.parse(schemaText) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value as Record<string, unknown>;
    } catch {
      setMessage("Schema JSON is invalid. Fix the JSON before generating an image.");
      return null;
    }
  };

  const generateSchema = async () => {
    if (!revision) return;
    setBusy("schema"); setMessage(null);
    try {
      const result = await runMainImageAction<MainImageSchemaResult>(inquiryId, { action: "schema", expectedContentRevision: revision });
      setSchemaMeta(result); setSchemaText(JSON.stringify(result.schema, null, 2)); setCandidate(null); setSaved(null);
      setMessage("Schema generated from the evidence pack. Review every field before image generation.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Schema generation failed"); }
    finally { setBusy(null); }
  };

  const generateCandidate = async () => {
    if (!revision || !state?.context) return;
    const schema = parseSchema();
    if (!schema) return;
    setBusy("candidate"); setMessage(null);
    try {
      const result = await runMainImageAction<MainImageCandidateResult>(inquiryId, {
        action: "candidate", expectedContentRevision: revision,
        factPackHash: state.context.fact_pack_hash,
        confirmedContextEvidenceIds: confirmedEvidence,
        schema,
      });
      setCandidate(result); setSaved(null); setReview({ fidelity: false, color: false, copy: false });
      setMessage("Candidate generated. Compare it with the source image and complete the review checklist.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Candidate generation failed"); }
    finally { setBusy(null); }
  };

  const saveCandidate = async () => {
    if (!revision || !state?.context || !candidate) return;
    const schema = parseSchema();
    if (!schema || !window.confirm("Save this reviewed candidate as an immutable Cloudflare R2 asset?")) return;
    setBusy("save"); setMessage(null);
    try {
      const result = await runMainImageAction<MainImageSavedAsset>(inquiryId, {
        action: "save", expectedContentRevision: revision,
        candidateBase64: candidate.candidate_base64, candidateToken: candidate.candidate_token,
        factPackHash: state.context.fact_pack_hash,
        confirmedContextEvidenceIds: confirmedEvidence,
        operatorExclusions: [], operatorOverrides: [], schema, operatorConfirmed: true,
      });
      setSaved(result); setMessage("Image saved to Cloudflare R2. It has not been published.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "R2 save failed"); }
    finally { setBusy(null); }
  };

  const publish = async () => {
    if (!revision || !saved || !state?.listing) return;
    const target = `${state.listing.shopCode} / ${state.listing.externalListingId}`;
    if (!window.confirm(`Publish the saved image as the main image for exactly ${target}?`)) return;
    setBusy("publish"); setMessage(null);
    try {
      const result = await runMainImageAction<{ outcome: string; content_revision: number }>(inquiryId, {
        action: "publish", expectedContentRevision: revision, assetId: saved.asset_id, operatorConfirmed: true,
      });
      await load();
      setCandidate(null); setSaved(null);
      setMessage(result.outcome === "replay" ? "This image was already published." : "Main image published successfully.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Mercari publish failed"); }
    finally { setBusy(null); }
  };

  const currentImage = state?.context?.listing.imageUrls[0];
  const allReviewed = Object.values(review).every(Boolean);

  return <section className="rounded-lg border border-gray-200 bg-white p-4" aria-labelledby="main-image-heading">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div>
        <h3 id="main-image-heading" className="text-sm font-medium text-gray-700">Main Image Creator</h3>
        <p className="mt-0.5 text-xs text-gray-500">Evidence-first MVP · OpenAI generation · exact inquiry listing only</p>
      </div>
      {state?.listing && <span className="rounded bg-violet-50 px-2 py-1 text-xs text-violet-700">
        {state.listing.shopCode} / <span className="notranslate" translate="no">{state.listing.externalListingId}</span>
      </span>}
    </div>

    {!state?.context ? <p className="text-xs text-amber-700">{state?.message || message || "Loading image context…"}</p> : <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <ImagePanel label="Current main image" src={currentImage} />
        <ImagePanel label="Generated candidate" src={candidate ? `data:${candidate.content_type};base64,${candidate.candidate_base64}` : undefined} />
      </div>

      <div className="rounded border border-gray-200 p-3">
        <h4 className="text-xs font-semibold text-gray-700">1. Verify source facts</h4>
        <p className="mt-1 text-xs text-gray-500">The schema can only cite evidence shown here. Values marked “Needs confirmation” are unverified listing copy.</p>
        {state.context.fact_pack.warnings.map((warning) => <p key={warning} className="mt-1 text-xs text-amber-700">{warning}</p>)}
        <div className="mt-2 max-h-36 space-y-1 overflow-y-auto rounded bg-gray-50 p-2 text-xs">
          {verifiedEvidence.map((item) => <p key={item.id}><span className="text-green-700">Verified</span> · {item.label}: <span className="notranslate" translate="no">{String(item.value)}</span></p>)}
          {contextEvidence.map((item) => <label key={item.id} className="flex items-start gap-2 text-amber-800">
            <input type="checkbox" checked={confirmedEvidence.includes(item.id)} onChange={(event) => setConfirmedEvidence((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} />
            <span>Needs confirmation · {item.label}: <span className="notranslate" translate="no">{String(item.value)}</span></span>
          </label>)}
          {!verifiedEvidence.length && !contextEvidence.length && <p className="text-gray-500">No copy evidence is available. Keep image text empty.</p>}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={generateSchema} disabled={Boolean(busy) || !mutationsEnabled} className="rounded bg-violet-600 px-3 py-1.5 text-xs text-white disabled:opacity-50">{busy === "schema" ? "Generating schema…" : "Generate schema"}</button>
          <span className="self-center text-xs text-gray-400">{state.context.fact_pack.assetIds.length} usable source image(s)</span>
        </div>
      </div>

      {schemaText && <div className="rounded border border-gray-200 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-semibold text-gray-700">2. Review and edit schema JSON</h4>
          {schemaMeta && <span className="text-xs text-gray-500">{schemaMeta.model} · {schemaMeta.prompt_version}</span>}
        </div>
        <textarea aria-label="Main image schema JSON" value={schemaText} onChange={(event) => { setSchemaText(event.target.value); setCandidate(null); setSaved(null); }} rows={18} spellCheck={false} className="notranslate mt-2 w-full rounded border border-gray-300 bg-gray-950 p-2 font-mono text-xs text-gray-100" translate="no" />
        {schemaMeta?.validation.errors.map((error) => <p key={error} className="mt-1 text-xs text-red-700">Schema error · {error}</p>)}
        {schemaMeta?.validation.warnings.map((warning) => <p key={warning} className="mt-1 text-xs text-amber-700">{warning}</p>)}
        <button type="button" onClick={generateCandidate} disabled={Boolean(busy) || !mutationsEnabled} className="mt-2 rounded bg-blue-600 px-3 py-1.5 text-xs text-white disabled:opacity-50">{busy === "candidate" ? "Generating image…" : "Generate candidate"}</button>
      </div>}

      {candidate && <div className="rounded border border-gray-200 p-3">
        <h4 className="text-xs font-semibold text-gray-700">3. Review, save, then publish</h4>
        <p className="mt-1 text-xs text-gray-500">{candidate.provider} / {candidate.model} · {candidate.width}×{candidate.height}</p>
        <div className="mt-2 space-y-1 text-xs text-gray-700">
          <ReviewCheck label="Product shape, material, and structure match the source" checked={review.fidelity} onChange={(value) => setReview({ ...review, fidelity: value })} />
          <ReviewCheck label="Colors and quantity are accurate" checked={review.color} onChange={(value) => setReview({ ...review, color: value })} />
          <ReviewCheck label="All visible text is accurate and contains no unsupported claim" checked={review.copy} onChange={(value) => setReview({ ...review, copy: value })} />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={saveCandidate} disabled={Boolean(busy) || !mutationsEnabled || !allReviewed || Boolean(saved)} className="rounded bg-emerald-600 px-3 py-1.5 text-xs text-white disabled:opacity-50">{busy === "save" ? "Saving…" : saved ? "Saved to R2" : "Save reviewed image to R2"}</button>
          <button type="button" onClick={publish} disabled={Boolean(busy) || !mutationsEnabled || !saved} className="rounded bg-blue-700 px-3 py-1.5 text-xs text-white disabled:opacity-50">{busy === "publish" ? "Publishing…" : "Publish to this Mercari listing"}</button>
        </div>
      </div>}

      {message && <p role="status" className="text-xs text-gray-700">{message}</p>}
      {!mutationsEnabled && <p className="text-xs text-amber-700">Main-image changes are currently disabled.</p>}
    </div>}
  </section>;
}

function ImagePanel({ label, src }: { label: string; src?: string }) {
  return <figure className="rounded border border-gray-200 bg-gray-50 p-2">
    <figcaption className="mb-2 text-xs font-medium text-gray-600">{label}</figcaption>
    {src ? <img src={src} alt={label} className="mx-auto aspect-square w-full max-w-72 rounded bg-white object-contain" /> : <div className="flex aspect-square max-h-72 items-center justify-center rounded bg-gray-100 text-xs text-gray-400">Not available</div>}
  </figure>;
}

function ReviewCheck({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="flex items-start gap-2"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span>{label}</span></label>;
}
