<style>
  h1 {
    margin: 1rem 0 0.5rem;
    font-size: 1.8rem;
  }
  h2 {
    margin-bottom: 0.5rem;
  }
  .search,
  section {
    max-width: 680px;
    margin-top: 1.5rem;
    padding: 1.5rem;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 12px;
  }
  label {
    display: block;
    margin-bottom: 0.4rem;
    font-weight: 600;
  }
  .row {
    display: flex;
    gap: 0.6rem;
  }
  .field {
    margin-bottom: 1.2rem;
  }
  input {
    min-width: 0;
    flex: 1;
    padding: 0.65rem;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    color: var(--color-text);
    background: var(--color-bg);
  }
  button {
    border: 1px solid var(--color-primary);
    border-radius: 6px;
    padding: 0.65rem 1rem;
    background: var(--color-primary);
    color: white;
    cursor: pointer;
  }
  button.secondary {
    background: var(--color-surface);
    color: var(--color-text);
    border-color: var(--color-border);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .global-note,
  .hint {
    margin: 0.7rem 0 1.2rem;
    color: var(--color-text-muted);
    font-size: 0.9rem;
  }
  .effective {
    margin-top: 1rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    margin-top: 1rem;
  }
  .error,
  .notice {
    max-width: 680px;
    padding: 1rem;
    margin-top: 1rem;
    border-radius: 8px;
    overflow-wrap: anywhere;
  }
  .error {
    background: #fff1f2;
    color: #9f1239;
  }
  .notice {
    background: #ecfdf5;
    color: #065f46;
  }
</style>

<script>
  import { resolve } from '$app/paths';
  import { onMount } from 'svelte';
  import {
    manualFields,
    formFor,
    dirtyPatch,
    effectiveRestockDateText,
    productRequest
  } from '$lib/tools/products.js';
  let query = $state('');
  let product = $state(null);
  let form = $state({});
  let busy = $state(false);
  let error = $state('');
  let notice = $state('');
  let uncertain = $state(false);
  let sequence = 0;
  const changed = () =>
    product &&
    manualFields.some(({ key }) => String(form[key] ?? '') !== String(product[key] ?? ''));
  onMount(() => {
    const guard = (event) => {
      if (changed() || uncertain || busy) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', guard);
    return () => {
      sequence++;
      window.removeEventListener('beforeunload', guard);
    };
  });
  function load(value) {
    product = value;
    form = formFor(value);
  }
  async function search() {
    if (busy || !query.trim()) return;
    if (
      (changed() || uncertain) &&
      !window.confirm('Discard unsaved changes and search another product?')
    )
      return;
    const current = ++sequence;
    product = null;
    error = '';
    notice = '';
    uncertain = false;
    busy = true;
    try {
      const value = await productRequest(query.trim());
      if (current === sequence) load(value);
    } catch (e) {
      if (current === sequence) error = e.message;
    } finally {
      if (current === sequence) busy = false;
    }
  }
  async function checkCurrent() {
    if (!product || busy) return;
    busy = true;
    error = '';
    notice = '';
    try {
      load(await productRequest(product.item_code));
      notice =
        'Current values loaded. The earlier request may still be finishing. Reload the page after reconciliation before a new edit.';
    } catch (e) {
      error = e.message;
    } finally {
      busy = false;
    }
  }
  async function save() {
    if (!product || busy || uncertain) return;
    let patch;
    try {
      patch = dirtyPatch(product, form);
    } catch (e) {
      error = e.message;
      return;
    }
    if (!Object.keys(patch).length) return;
    const code = product.item_code;
    busy = true;
    error = '';
    notice = '';
    let writeReturned = false;
    try {
      await productRequest(code, patch);
      writeReturned = true;
      const current = await productRequest(code);
      load(current);
      notice = Object.entries(patch).every(([key, value]) => current[key] === value)
        ? 'Manual values saved and verified. Effective cost is shown below. Marketplace synchronization is separate.'
        : 'Current values differ from your submission. Another update may have occurred; review the values before editing.';
    } catch (e) {
      error = writeReturned
        ? `Save returned success, but readback is not confirmed. ${e.message}`
        : e.message;
      const definitelyRejected =
        !writeReturned && e.status && [400, 401, 403, 404, 409, 413, 503].includes(e.status);
      if (definitelyRejected) return;
      uncertain = true;
      // Never replay a write. A failed/ambiguous write gets one read-only check.
      if (!writeReturned) {
        try {
          const current = await productRequest(code);
          load(current);
          const matches = Object.entries(patch).every(([key, value]) => current[key] === value);
          if (matches) uncertain = false;
          notice = matches
            ? 'Current values match your requested values (verified by readback).'
            : 'Current values do not yet match. The earlier save may still be running; do not submit another change until reconciled.';
        } catch {
          /* Keep uncertain state until a successful read-only check. */
        }
      }
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Product update tool — Ops Portal</title></svelte:head>
<a href={resolve('/tools')}>← Tools</a>
<h1>Product update tool</h1>
<p>Search by complete Item Code. No linked order is required.</p>
<form
  class="search"
  onsubmit={(event) => {
    event.preventDefault();
    search();
  }}
>
  <label for="item-code">Item Code</label>
  <div class="row">
    <input
      id="item-code"
      bind:value={query}
      placeholder="Enter complete Item Code"
      maxlength="128"
      required
      disabled={busy}
      autocomplete="off"
    /><button disabled={busy || !query.trim()} type="submit">{busy ? 'Working…' : 'Search'}</button>
  </div>
</form>
{#if error}<div class="error" role="alert">{error}</div>{/if}
{#if notice}<div class="notice" role="status">{notice}</div>{/if}
{#if product}
  <section>
    <h2>{product.item_code}</h2>
    <p class="global-note">
      Changes apply to this product globally, across orders and shops that use its master data.
    </p>
    <form
      onsubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      {#each manualFields as field (field.key)}
        <label for={field.key}>{field.label}</label>
        <div class="row field">
          <input
            id={field.key}
            type={field.type}
            value={form[field.key]}
            oninput={(event) => {
              form[field.key] = event.currentTarget.value;
            }}
            min={field.type === 'number' ? '0.000001' : undefined}
            max={field.type === 'number' ? '99999999' : undefined}
            step={field.type === 'number' ? 'any' : undefined}
            disabled={busy || uncertain}
          />
          <button
            class="secondary"
            type="button"
            disabled={busy || uncertain || !form[field.key]}
            onclick={() => {
              form[field.key] = '';
            }}>Clear</button
          >
        </div>
      {/each}
      <p class="effective">
        Effective Restock Date: <strong>{effectiveRestockDateText(product)}</strong>
      </p>
      <p class="effective">
        Effective Cost: <strong
          >{product.effective_cost_price == null
            ? '—'
            : `¥${Number(product.effective_cost_price).toLocaleString()}`}</strong
        >
      </p>
      <p class="hint">
        Blank fields remove manual overrides. Protection follows the existing JST catalog rules.
        Effective restock date is the latest stored date returned by the product owner and may
        update after catalog synchronization. Effective cost reflects the latest owner readback;
        marketplace synchronization is separate.
      </p>
      <div class="actions">
        <button
          type="button"
          class="secondary"
          disabled={busy || uncertain}
          onclick={() => {
            form = formFor(product);
            error = '';
            notice = '';
          }}>Cancel</button
        >
        <button disabled={busy || uncertain || !changed()} type="submit"
          >{busy ? 'Working…' : 'Save changes'}</button
        >
        {#if uncertain}<button
            type="button"
            class="secondary"
            disabled={busy}
            onclick={checkCurrent}>Check current values</button
          >{/if}
      </div>
    </form>
  </section>
{/if}
