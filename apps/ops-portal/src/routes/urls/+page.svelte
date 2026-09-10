<style>
  .page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--spacing-lg);
    margin-bottom: var(--spacing-lg);
  }

  .header-badges {
    display: flex;
    gap: var(--spacing-xs);
    flex-wrap: wrap;
  }

  .urls-layout {
    display: grid;
    grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
    gap: var(--spacing-lg);
  }

  .add-panel {
    align-self: start;
    position: sticky;
    top: calc(var(--header-height) + var(--spacing-lg));
  }

  .url-form {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-md);
  }

  .url-form label {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-xs);
  }

  .url-form span {
    font-size: var(--font-size-xs);
    color: var(--color-text-muted);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .url-form input,
  .url-form select,
  .url-form textarea,
  .toolbar-filters select {
    width: 100%;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: 0.75rem;
    background: var(--color-surface);
    color: var(--color-text);
  }

  .url-form textarea {
    resize: vertical;
  }

  .form-row {
    display: grid;
    grid-template-columns: 1fr 160px;
    gap: var(--spacing-md);
  }

  .form-actions {
    display: flex;
    gap: var(--spacing-sm);
    flex-wrap: wrap;
  }

  .form-error {
    color: #b91c1c;
    font-size: var(--font-size-sm);
  }

  .collection-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--spacing-md);
    margin-bottom: var(--spacing-sm);
  }

  .toolbar-extra {
    display: flex;
    gap: var(--spacing-sm);
    margin-bottom: var(--spacing-md);
  }

  .search-wrapper {
    flex: 1;
    max-width: 420px;
  }

  .toolbar-filters {
    display: flex;
    gap: var(--spacing-sm);
    align-items: center;
    flex-wrap: wrap;
  }

  .url-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: var(--spacing-md);
  }

  .url-card {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-md);
  }

  .url-card-header {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-sm);
  }

  .url-card-header h3 {
    font-size: var(--font-size-lg);
  }

  .url-card-badges {
    display: flex;
    gap: var(--spacing-xs);
    flex-wrap: wrap;
  }

  .url-link {
    display: block;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    word-break: break-word;
  }

  .url-card-actions {
    display: flex;
    gap: var(--spacing-sm);
    flex-wrap: wrap;
  }

  .empty-state {
    text-align: center;
    padding: var(--spacing-2xl);
    color: var(--color-text-muted);
  }

  @media (max-width: 900px) {
    .urls-layout {
      grid-template-columns: 1fr;
    }

    .add-panel {
      position: static;
    }
  }

  @media (max-width: 640px) {
    .page-header,
    .collection-toolbar {
      flex-direction: column;
      align-items: stretch;
    }

    .form-row {
      grid-template-columns: 1fr;
    }

    .search-wrapper {
      max-width: none;
    }
  }
</style>

<script>
  /* eslint-disable svelte/no-navigation-without-resolve -- collection entries are external URLs */
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { urls as seedUrls } from '$lib/utils/data.js';
  import { searchItems } from '$lib/utils/search.js';
  import SearchBar from '$lib/components/SearchBar.svelte';
  import Badge from '$lib/components/Badge.svelte';

  const STORAGE_KEY = 'ops-portal-items-urls';

  let storedItems = $state([]);
  // Writable because SearchBar also updates the query without navigation.
  // eslint-disable-next-line svelte/prefer-writable-derived
  let query = $state('');

  $effect(() => {
    query = page.url.searchParams.get('q') ?? '';
  });
  let activeCategory = $state('');
  let activeEnvironment = $state('');
  let editingId = $state(null);
  let form = $state({
    label: '',
    url: '',
    category: '',
    environment: 'production',
    notes: ''
  });
  let ready = $state(false);
  let error = $state('');

  onMount(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          storedItems = parsed;
          return;
        }
      }
      storedItems = seedUrls.map((u) => ({ ...u }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(storedItems));
    } catch {
      error = 'Could not load saved URLs from this browser.';
    } finally {
      ready = true;
    }
  });

  const categoryOptions = $derived(
    [...new Set(storedItems.map((entry) => entry.category).filter(Boolean))].sort()
  );

  const environmentOptions = $derived(
    [...new Set(storedItems.map((entry) => entry.environment).filter(Boolean))].sort()
  );

  const filteredUrls = $derived.by(() => {
    let result = storedItems;
    if (activeCategory) {
      result = result.filter((entry) => entry.category === activeCategory);
    }
    if (activeEnvironment) {
      result = result.filter((entry) => entry.environment === activeEnvironment);
    }
    return searchItems(result, query, ['label', 'url', 'category', 'notes', 'environment']);
  });

  function persist(items) {
    storedItems = items;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    }
  }

  function resetForm() {
    form = {
      label: '',
      url: '',
      category: '',
      environment: 'production',
      notes: ''
    };
    editingId = null;
    error = '';
  }

  function handleSubmit(event) {
    event.preventDefault();
    error = '';

    let normalizedUrl = form.url.trim();
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      normalizedUrl = `https://${normalizedUrl}`;
    }

    try {
      new URL(normalizedUrl);
    } catch {
      error = 'Enter a valid URL, including domain.';
      return;
    }

    if (!form.label.trim()) {
      error = 'Enter a label for the URL.';
      return;
    }

    if (editingId) {
      persist(
        storedItems.map((item) =>
          item.id === editingId
            ? {
                ...item,
                label: form.label.trim(),
                url: normalizedUrl,
                category: form.category.trim() || 'General',
                environment: form.environment,
                notes: form.notes.trim()
              }
            : item
        )
      );
    } else {
      const entry = {
        id: `manual-${Date.now()}`,
        label: form.label.trim(),
        url: normalizedUrl,
        category: form.category.trim() || 'General',
        environment: form.environment,
        status: 'active',
        source: 'manual',
        notes: form.notes.trim()
      };
      persist([entry, ...storedItems]);
    }

    resetForm();
  }

  function editItem(id) {
    const item = storedItems.find((i) => i.id === id);
    if (!item) return;
    form = {
      label: item.label || '',
      url: item.url || '',
      category: item.category || '',
      environment: item.environment || 'production',
      notes: item.notes || ''
    };
    editingId = id;
    error = '';
  }

  function removeItem(id) {
    persist(storedItems.filter((item) => item.id !== id));
  }

  function resetToSeed() {
    const manualItems = storedItems.filter((i) => i.source === 'manual');
    const freshSeed = seedUrls.map((u) => ({ ...u }));
    persist([...freshSeed, ...manualItems]);
  }

  function clearAllManual() {
    const seedOnly = storedItems.filter((i) => i.source !== 'manual');
    persist(seedOnly);
  }
</script>

<svelte:head>
  <title>URL Collection — Ops Portal</title>
</svelte:head>

<div class="page-header">
  <div>
    <h1>URL Collection</h1>
    <p class="text-muted text-sm mt-sm">
      Internal frontend entry points for operators. Changes are saved in this browser.
    </p>
  </div>
  <div class="header-badges">
    <Badge>{storedItems.length} total</Badge>
    <Badge variant="installed">{storedItems.filter((i) => i.source === 'seed').length} seed</Badge>
  </div>
</div>

<div class="urls-layout">
  <section class="card add-panel">
    <h2>{editingId ? 'Edit URL' : 'Add URL'}</h2>
    <p class="text-muted text-sm mt-sm">
      {editingId ? 'Update the URL details below.' : 'Add a new operator-facing web entry point.'}
    </p>

    <form class="url-form mt-lg" onsubmit={handleSubmit}>
      <label>
        <span>Label</span>
        <input bind:value={form.label} type="text" placeholder="Mercari Shop Dashboard" />
      </label>

      <label>
        <span>URL</span>
        <input bind:value={form.url} type="text" placeholder="ops.homesbliss.net" />
      </label>

      <div class="form-row">
        <label>
          <span>Category</span>
          <input bind:value={form.category} type="text" placeholder="Marketplace Ops" />
        </label>

        <label>
          <span>Environment</span>
          <select bind:value={form.environment}>
            <option value="production">Production</option>
            <option value="staging">Staging</option>
            <option value="preview">Preview</option>
            <option value="local">Local</option>
          </select>
        </label>
      </div>

      <label>
        <span>Notes</span>
        <textarea bind:value={form.notes} rows="4" placeholder="What operators use this page for."
        ></textarea>
      </label>

      {#if error}
        <p class="form-error">{error}</p>
      {/if}

      <div class="form-actions">
        <button type="submit" class="btn btn-primary">{editingId ? 'Save' : 'Add URL'}</button>
        <button type="button" class="btn" onclick={resetForm}
          >{editingId ? 'Cancel' : 'Reset'}</button
        >
      </div>
    </form>
  </section>

  <section class="collection-panel">
    <div class="collection-toolbar">
      <div class="search-wrapper">
        <SearchBar
          placeholder="Search URLs..."
          value={query}
          onchange={(value) => (query = value)}
          onsubmit={(value) => (query = value)}
        />
      </div>

      <div class="toolbar-filters">
        <select bind:value={activeCategory}>
          <option value="">All categories</option>
          {#each categoryOptions as category (category)}
            <option value={category}>{category}</option>
          {/each}
        </select>

        <select bind:value={activeEnvironment}>
          <option value="">All environments</option>
          {#each environmentOptions as environment (environment)}
            <option value={environment}>{environment}</option>
          {/each}
        </select>
      </div>
    </div>

    <div class="toolbar-extra">
      <button type="button" class="btn btn-sm" onclick={resetToSeed}>Reset seed</button>
      {#if storedItems.some((i) => i.source === 'manual')}
        <button type="button" class="btn btn-sm" onclick={clearAllManual}>Clear manual</button>
      {/if}
    </div>

    {#if !ready}
      <div class="card empty-state">
        <p>Loading saved URLs...</p>
      </div>
    {:else if filteredUrls.length === 0}
      <div class="card empty-state">
        <p>No URLs match the current search or filters.</p>
      </div>
    {:else}
      <div class="url-grid">
        {#each filteredUrls as entry (entry.id)}
          <article class="card url-card">
            <div class="url-card-header">
              <div>
                <h3>{entry.label}</h3>
                <p class="text-sm text-muted mt-sm">{entry.notes || 'No notes provided.'}</p>
              </div>
              <div class="url-card-badges">
                <Badge>{entry.category}</Badge>
                <Badge variant={entry.environment === 'production' ? 'installed' : 'workspace'}>
                  {entry.environment}
                </Badge>
                {#if entry.status === 'pending'}
                  <Badge variant="workspace">pending</Badge>
                {/if}
                {#if entry.source === 'manual'}
                  <Badge variant="default">manual</Badge>
                {/if}
              </div>
            </div>

            <!-- External operator-managed URL; SvelteKit resolve only accepts internal paths. -->
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
            <a
              href={entry.url}
              target="_blank"
              rel="noreferrer"
              class="url-link"
              data-sveltekit-reload
            >
              {entry.url}
            </a>

            <div class="url-card-actions">
              <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
              <a
                href={entry.url}
                target="_blank"
                rel="noreferrer"
                class="btn btn-primary"
                data-sveltekit-reload>Open</a
              >
              <button
                type="button"
                class="btn"
                onclick={() => navigator.clipboard?.writeText(entry.url)}
              >
                Copy
              </button>
              <button type="button" class="btn" onclick={() => editItem(entry.id)}>Edit</button>
              <button type="button" class="btn" onclick={() => removeItem(entry.id)}>Remove</button>
            </div>
          </article>
        {/each}
      </div>
    {/if}
  </section>
</div>
