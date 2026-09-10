<style>
  .filter-panel {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--spacing-md);
    padding: var(--spacing-md);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    margin-bottom: var(--spacing-lg);
  }

  .filter-group {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .filter-group label {
    font-size: var(--font-size-xs);
    color: var(--color-text-muted);
    font-weight: 500;
  }

  .filter-group select {
    padding: var(--spacing-xs) var(--spacing-sm);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    background: var(--color-surface);
    color: var(--color-text);
    min-width: 140px;
  }

  .clear-btn {
    margin-left: auto;
  }
</style>

<script>
  /** @type {{
   *   filters: { key: string, label: string, options: { value: string, label: string }[] }[],
   *   active: Record<string, string>,
   *   onchange: (key: string, value: string) => void
   * }}
   */
  let { filters = [], active = {}, onchange } = $props();

  function handleChange(key, value) {
    onchange(key, value);
  }

  function clearAll() {
    for (const f of filters) {
      onchange(f.key, '');
    }
  }

  const hasActive = $derived(Object.values(active).some(Boolean));
</script>

<div class="filter-panel">
  {#each filters as f (f.key)}
    <div class="filter-group">
      <label for="filter-{f.key}">{f.label}</label>
      <select
        id="filter-{f.key}"
        value={active[f.key] || ''}
        onchange={(e) => handleChange(f.key, e.target.value)}
      >
        <option value="">All</option>
        {#each f.options as opt (opt.value)}
          <option value={opt.value}>{opt.label}</option>
        {/each}
      </select>
    </div>
  {/each}
  {#if hasActive}
    <button class="btn btn-sm clear-btn" onclick={clearAll}>Clear</button>
  {/if}
</div>
