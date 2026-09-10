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
  import { onMount } from 'svelte';
  import { domains as seedDomains } from '$lib/utils/data.js';
  import DomainCard from '$lib/components/DomainCard.svelte';
  import EditorModal from '$lib/components/EditorModal.svelte';

  const STORAGE_KEY = 'ops-portal-items-domains';

  let storedItems = $state([]);
  let ready = $state(false);
  let showEditor = $state(false);
  let editingItem = $state(null);

  const cards = $derived(
    storedItems.map((d) => ({
      ...d,
      repoCount: Array.isArray(d.repoIds) ? d.repoIds.length : 0,
      skillCount: Array.isArray(d.skillIds) ? d.skillIds.length : 0
    }))
  );

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
      storedItems = seedDomains.map((d) => ({ ...d }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(storedItems));
    } catch {
      storedItems = seedDomains.map((d) => ({ ...d }));
    } finally {
      ready = true;
    }
  });

  function persist(items) {
    storedItems = items;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  }

  const iconOptions = [
    { value: 'shopping-bag', label: 'Shopping Bag' },
    { value: 'globe', label: 'Globe' },
    { value: 'shopping-cart', label: 'Shopping Cart' },
    { value: 'search', label: 'Search' },
    { value: 'database', label: 'Database' },
    { value: 'edit', label: 'Edit' },
    { value: 'code', label: 'Code' },
    { value: 'file-text', label: 'File Text' },
    { value: 'message-circle', label: 'Message Circle' },
    { value: 'settings', label: 'Settings' },
    { value: 'package', label: 'Package' },
    { value: 'help-circle', label: 'Help Circle' },
    { value: 'flag', label: 'Flag' }
  ];

  const editorFields = [
    { key: 'label', label: 'Label', type: 'text', placeholder: 'Domain Name', required: true },
    {
      key: 'description',
      label: 'Description',
      type: 'textarea',
      placeholder: 'What this domain covers'
    },
    { key: 'iconHint', label: 'Icon', type: 'select', options: iconOptions },
    {
      key: 'repoIds',
      label: 'Repo IDs',
      type: 'text',
      placeholder: 'Comma-separated: repo1, repo2'
    },
    {
      key: 'skillIds',
      label: 'Skill IDs',
      type: 'text',
      placeholder: 'Comma-separated: skill1, skill2'
    },
    {
      key: 'relatedDomainIds',
      label: 'Related Domain IDs',
      type: 'text',
      placeholder: 'Comma-separated: domain1, domain2'
    }
  ];

  function openAdd() {
    editingItem = {
      label: '',
      description: '',
      iconHint: 'search',
      repoIds: '',
      skillIds: '',
      relatedDomainIds: ''
    };
    showEditor = true;
  }

  function openEdit(id) {
    const item = storedItems.find((i) => i.id === id);
    if (!item) return;
    editingItem = {
      ...item,
      repoIds: Array.isArray(item.repoIds) ? item.repoIds.join(', ') : item.repoIds || '',
      skillIds: Array.isArray(item.skillIds) ? item.skillIds.join(', ') : item.skillIds || '',
      relatedDomainIds: Array.isArray(item.relatedDomainIds)
        ? item.relatedDomainIds.join(', ')
        : item.relatedDomainIds || ''
    };
    showEditor = true;
  }

  function handleSave(data) {
    const toArray = (val) =>
      val
        ? val
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];

    const entry = {
      ...data,
      repoIds: toArray(data.repoIds),
      skillIds: toArray(data.skillIds),
      relatedDomainIds: toArray(data.relatedDomainIds),
      id:
        editingItem?.id?.startsWith('manual-') || editingItem?.id
          ? editingItem.id
          : `manual-${Date.now()}`,
      source: editingItem?.id
        ? storedItems.find((i) => i.id === editingItem.id)?.source || 'manual'
        : 'manual'
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
    const freshSeed = seedDomains.map((d) => ({ ...d }));
    persist([...freshSeed, ...manualItems]);
  }
</script>

<svelte:head>
  <title>Domains — Ops Portal</title>
</svelte:head>

<div class="page-header">
  <div>
    <h1>Capability Domains</h1>
    <p class="text-muted text-sm">
      {storedItems.length} total &middot; {storedItems.filter((i) => i.source === 'seed').length} seed
    </p>
  </div>
  <div class="header-actions">
    <button type="button" class="btn btn-sm" onclick={resetToSeed}>Reset seed</button>
    <button type="button" class="btn btn-primary" onclick={openAdd}>Add Domain</button>
  </div>
</div>

{#if !ready}
  <div class="empty-state">
    <p>Loading...</p>
  </div>
{:else}
  <div class="card-grid">
    {#each cards as card (card.id)}
      <div class="card-item">
        <DomainCard {...card} />
        <div class="card-actions">
          <button type="button" class="btn btn-sm" onclick={() => openEdit(card.id)}>Edit</button>
          <button type="button" class="btn btn-sm" onclick={() => removeItem(card.id)}
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
    ? 'Edit Domain'
    : 'Add Domain'}
  fields={editorFields}
  data={editingItem ?? {}}
  onsave={handleSave}
  onclose={() => {
    showEditor = false;
    editingItem = null;
  }}
/>
