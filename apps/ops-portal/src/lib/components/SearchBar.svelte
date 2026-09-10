<style>
  .search-bar {
    display: flex;
    align-items: center;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: 0 var(--spacing-sm);
    transition: border-color 0.15s;
  }

  .search-bar:focus-within {
    border-color: var(--color-primary);
    background: var(--color-surface);
  }

  .search-icon {
    flex-shrink: 0;
    color: var(--color-text-muted);
  }

  input {
    border: none;
    background: transparent;
    padding: var(--spacing-sm);
    width: 100%;
    outline: none;
    font-size: var(--font-size-sm);
    color: var(--color-text);
  }

  input::placeholder {
    color: var(--color-text-muted);
  }
</style>

<script>
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';

  /** @type {{ placeholder?: string, basePath?: string, value?: string, onchange?: ((value: string) => void) | null, onsubmit?: ((value: string) => void) | null }} */
  let {
    placeholder = 'Search skills, repos, domains...',
    basePath = '/skills',
    value = '',
    onchange = null,
    onsubmit = null
  } = $props();

  let query = $state('');

  $effect(() => {
    if (value !== untrack(() => query)) {
      query = value;
    }
  });

  function handleSubmit(e) {
    e.preventDefault();
    const q = query.trim();
    if (onsubmit) {
      onsubmit(q);
    } else if (q) {
      goto(resolve(`${basePath}?q=${encodeURIComponent(q)}`));
    } else {
      goto(resolve(basePath));
    }
  }

  function handleInput() {
    onchange?.(query);
  }
</script>

<form class="search-bar" onsubmit={handleSubmit} role="search">
  <svg
    class="search-icon"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
  <input type="search" bind:value={query} {placeholder} oninput={handleInput} aria-label="Search" />
</form>
