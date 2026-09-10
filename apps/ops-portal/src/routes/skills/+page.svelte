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
  import { skills as seedSkills, domains } from '$lib/utils/data.js';
  import { searchItems } from '$lib/utils/search.js';
  import { matchesDomain } from '$lib/utils/filter.js';
  import SkillCard from '$lib/components/SkillCard.svelte';
  import FilterPanel from '$lib/components/FilterPanel.svelte';
  import SearchBar from '$lib/components/SearchBar.svelte';
  import EditorModal from '$lib/components/EditorModal.svelte';

  const STORAGE_KEY = 'ops-portal-items-skills';

  let storedItems = $state([]);
  let ready = $state(false);

  let activeFilters = $state({ installed: '', level: '', domain: '' });
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

  const domainOptions = $derived(domains.map((d) => ({ value: d.id, label: d.label })));

  const filtered = $derived.by(() => {
    let result = storedItems;
    if (activeFilters.installed === 'true') {
      result = result.filter((s) => s.installed);
    } else if (activeFilters.installed === 'false') {
      result = result.filter((s) => !s.installed);
    }
    if (activeFilters.level) {
      result = result.filter((s) => s.level === activeFilters.level);
    }
    result = result.filter((s) => matchesDomain(s.capabilityDomains, activeFilters.domain));
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
      storedItems = seedSkills.map((s) => ({ ...s }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(storedItems));
    } catch {
      storedItems = seedSkills.map((s) => ({ ...s }));
    } finally {
      ready = true;
    }
  });

  function persist(items) {
    storedItems = items;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  }

  const editorFields = [
    { key: 'name', label: 'Name', type: 'text', placeholder: 'skill-name', required: true },
    {
      key: 'description',
      label: 'Description',
      type: 'textarea',
      placeholder: 'What this skill does'
    },
    {
      key: 'level',
      label: 'Level',
      type: 'select',
      options: [
        { value: 'account', label: 'Account' },
        { value: 'agent', label: 'Agent' }
      ]
    },
    {
      key: 'installed',
      label: 'Installed',
      type: 'checkbox',
      placeholder: 'Skill is installed locally'
    },
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
      description: '',
      level: 'account',
      installed: false,
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
      installed: !!data.installed
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
    const freshSeed = seedSkills.map((s) => ({ ...s }));
    persist([...freshSeed, ...manualItems]);
  }
</script>

<svelte:head>
  <title>Skills — Ops Portal</title>
</svelte:head>

<div class="page-header">
  <div>
    <h1>Skills</h1>
    <p class="text-muted text-sm">
      {storedItems.length} total &middot; {storedItems.filter((i) => i.source === 'seed').length} seed
      &middot; {storedItems.filter((s) => s.installed).length} installed
    </p>
  </div>
  <div class="header-actions">
    <button type="button" class="btn btn-sm" onclick={resetToSeed}>Reset seed</button>
    <button type="button" class="btn btn-primary" onclick={openAdd}>Add Skill</button>
  </div>
</div>

<div class="search-filter-row">
  <div class="search-wrapper">
    <SearchBar
      placeholder="Search skills..."
      value={query}
      onchange={(value) => (query = value)}
      onsubmit={(value) => (query = value)}
    />
  </div>
</div>

<FilterPanel
  filters={[
    {
      key: 'installed',
      label: 'Status',
      options: [
        { value: 'true', label: 'Installed' },
        { value: 'false', label: 'Workspace only' }
      ]
    },
    {
      key: 'level',
      label: 'Level',
      options: [
        { value: 'account', label: 'Account' },
        { value: 'agent', label: 'Agent' }
      ]
    },
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
    <p>No skills match your filters.</p>
    <a href={resolve('/skills')} class="btn btn-sm mt-sm">Clear filters</a>
  </div>
{:else}
  <div class="card-grid">
    {#each filtered as skill (skill.id)}
      <div class="card-item">
        <SkillCard {...skill} />
        <div class="card-actions">
          <button type="button" class="btn btn-sm" onclick={() => openEdit(skill.id)}>Edit</button>
          <button type="button" class="btn btn-sm" onclick={() => removeItem(skill.id)}
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
    ? 'Edit Skill'
    : 'Add Skill'}
  fields={editorFields}
  data={editingItem ?? {}}
  onsave={handleSave}
  onclose={() => {
    showEditor = false;
    editingItem = null;
  }}
/>
