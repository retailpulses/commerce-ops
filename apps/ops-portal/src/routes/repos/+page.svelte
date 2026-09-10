<style>
  .page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--spacing-lg);
    margin-bottom: var(--spacing-lg);
  }

  .header-actions {
    display: flex;
    gap: var(--spacing-sm);
    flex-shrink: 0;
  }

  .search-filter-row {
    margin-bottom: var(--spacing-md);
  }

  .search-wrapper {
    max-width: 400px;
  }

  .empty-state {
    text-align: center;
    padding: var(--spacing-2xl);
    color: var(--color-text-muted);
  }

  .card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: var(--spacing-lg);
  }

  .card-item {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-sm);
  }

  .card-actions {
    display: flex;
    gap: var(--spacing-xs);
  }
</style>

<script>
  import { page } from '$app/state';
  import { resolve } from '$app/paths';
  import { onMount } from 'svelte';
  import { repos as seedRepos, domains } from '$lib/utils/data.js';
  import { searchItems } from '$lib/utils/search.js';
  import { matchesDomain } from '$lib/utils/filter.js';
  import RepoCard from '$lib/components/RepoCard.svelte';
  import FilterPanel from '$lib/components/FilterPanel.svelte';
  import SearchBar from '$lib/components/SearchBar.svelte';
  import EditorModal from '$lib/components/EditorModal.svelte';

  const STORAGE_KEY = 'ops-portal-items-repos';

  let storedItems = $state([]);
  let ready = $state(false);

  let activeFilters = $state({ language: '', domain: '' });
  // Writable because SearchBar also updates the query without navigation.
  // eslint-disable-next-line svelte/prefer-writable-derived
  let query = $state('');
  let showEditor = $state(false);
  let editingItem = $state(null);

  $effect(() => {
    query = page.url.searchParams.get('q') ?? '';
  });

  function updateFilter(key, value) {
    activeFilters = { ...activeFilters, [key]: value };
  }

  const languages = $derived(
    [...new Set(storedItems.map((r) => r.primaryLanguage).filter(Boolean))].sort()
  );

  const domainOptions = $derived(domains.map((d) => ({ value: d.id, label: d.label })));

  const filtered = $derived.by(() => {
    let result = storedItems;
    if (activeFilters.language) {
      result = result.filter((r) => r.primaryLanguage === activeFilters.language);
    }
    result = result.filter((r) => matchesDomain(r.capabilityDomains, activeFilters.domain));
    result = searchItems(result, query, ['name', 'description', 'id']);
    return result;
  });

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
      storedItems = seedRepos.map((r) => ({ ...r }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(storedItems));
    } catch {
      // fallback to seed
      storedItems = seedRepos.map((r) => ({ ...r }));
    } finally {
      ready = true;
    }
  });

  function persist(items) {
    storedItems = items;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  }

  const editorFields = [
    { key: 'name', label: 'Name', type: 'text', placeholder: 'repo-name', required: true },
    { key: 'url', label: 'URL', type: 'text', placeholder: 'https://github.com/retailpulses/repo' },
    {
      key: 'description',
      label: 'Description',
      type: 'textarea',
      placeholder: 'What this repo does'
    },
    { key: 'primaryLanguage', label: 'Primary Language', type: 'text', placeholder: 'Python' },
    { key: 'visibility', label: 'Visibility', type: 'select', options: ['PRIVATE', 'PUBLIC'] },
    { key: 'defaultBranch', label: 'Default Branch', type: 'text', placeholder: 'main' },
    {
      key: 'localClonePath',
      label: 'Local Clone Path',
      type: 'text',
      placeholder: '20_REPOS/repo-name'
    },
    { key: 'isArchived', label: 'Archived', type: 'checkbox' },
    { key: 'isFork', label: 'Fork', type: 'checkbox' },
    {
      key: 'capabilityDomains',
      label: 'Capability Domains',
      type: 'text',
      placeholder: 'Comma-separated: ops, catalog'
    }
  ];

  function openAdd() {
    editingItem = {
      name: '',
      url: '',
      description: '',
      primaryLanguage: '',
      visibility: 'PRIVATE',
      defaultBranch: 'main',
      localClonePath: '',
      isArchived: false,
      isFork: false,
      capabilityDomains: ''
    };
    showEditor = true;
  }

  function openEdit(id) {
    const item = storedItems.find((i) => i.id === id);
    if (!item) return;
    editingItem = {
      ...item,
      capabilityDomains: Array.isArray(item.capabilityDomains)
        ? item.capabilityDomains.join(', ')
        : item.capabilityDomains || ''
    };
    showEditor = true;
  }

  function handleSave(data) {
    const domainsArr = data.capabilityDomains
      ? data.capabilityDomains
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    const entry = {
      ...data,
      capabilityDomains: domainsArr,
      id:
        editingItem?.id?.startsWith('manual-') || editingItem?.id
          ? editingItem.id
          : `manual-${Date.now()}`,
      source: editingItem?.id
        ? storedItems.find((i) => i.id === editingItem.id)?.source || 'manual'
        : 'manual',
      isArchived: !!data.isArchived,
      isFork: !!data.isFork
    };

    if (editingItem?.id && storedItems.some((i) => i.id === editingItem.id)) {
      persist(storedItems.map((i) => (i.id === editingItem.id ? entry : i)));
    } else {
      persist([entry, ...storedItems]);
    }
    showEditor = false;
    editingItem = null;
  }

  function removeItem(id) {
    persist(storedItems.filter((i) => i.id !== id));
  }

  function resetToSeed() {
    const manualItems = storedItems.filter((i) => i.source === 'manual');
    const freshSeed = seedRepos.map((r) => ({ ...r }));
    persist([...freshSeed, ...manualItems]);
  }
</script>

<svelte:head>
  <title>Repos — Ops Portal</title>
</svelte:head>

<div class="page-header">
  <div>
    <h1>Repositories</h1>
    <p class="text-muted text-sm">
      {storedItems.length} total &middot; {storedItems.filter((i) => i.source === 'seed').length} seed
    </p>
  </div>
  <div class="header-actions">
    <button type="button" class="btn btn-sm" onclick={resetToSeed}>Reset seed</button>
    <button type="button" class="btn btn-primary" onclick={openAdd}>Add Repo</button>
  </div>
</div>

<div class="search-filter-row">
  <div class="search-wrapper">
    <SearchBar
      placeholder="Search repos..."
      value={query}
      onchange={(value) => (query = value)}
      onsubmit={(value) => (query = value)}
    />
  </div>
</div>

<FilterPanel
  filters={[
    { key: 'language', label: 'Language', options: languages.map((l) => ({ value: l, label: l })) },
    { key: 'domain', label: 'Domain', options: domainOptions }
  ]}
  active={activeFilters}
  onchange={updateFilter}
/>

{#if !ready}
  <div class="empty-state">
    <p>Loading...</p>
  </div>
{:else if filtered.length === 0}
  <div class="empty-state">
    <p>No repos match your filters.</p>
    <a href={resolve('/repos')} class="btn btn-sm mt-sm">Clear filters</a>
  </div>
{:else}
  <div class="card-grid">
    {#each filtered as repo (repo.id)}
      <div class="card-item">
        <RepoCard {...repo} />
        <div class="card-actions">
          <button type="button" class="btn btn-sm" onclick={() => openEdit(repo.id)}>Edit</button>
          <button type="button" class="btn btn-sm" onclick={() => removeItem(repo.id)}
            >Remove</button
          >
        </div>
      </div>
    {/each}
  </div>
{/if}

<EditorModal
  show={showEditor}
  title={editingItem?.id && storedItems.some((i) => i.id === editingItem.id)
    ? 'Edit Repo'
    : 'Add Repo'}
  fields={editorFields}
  data={editingItem ?? {}}
  onsave={handleSave}
  onclose={() => {
    showEditor = false;
    editingItem = null;
  }}
/>
