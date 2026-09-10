<style>
  .breadcrumb ol {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--spacing-xs);
    font-size: var(--font-size-sm);
  }

  .breadcrumb li {
    display: flex;
    align-items: center;
    gap: var(--spacing-xs);
  }

  .breadcrumb a {
    color: var(--color-text-muted);
  }

  .breadcrumb a:hover {
    color: var(--color-primary);
  }

  .breadcrumb span[aria-current] {
    color: var(--color-text);
    font-weight: 500;
  }

  .sep {
    color: var(--color-border);
  }
</style>

<script>
  import { resolve } from '$app/paths';

  /** @type {{ segments: { label: string, href?: string }[] }} */
  let { segments = [] } = $props();
</script>

<nav class="breadcrumb" aria-label="Breadcrumb">
  <ol>
    {#each segments as seg, i (seg.href ?? seg.label)}
      <li>
        {#if seg.href}
          <a href={resolve(seg.href)}>{seg.label}</a>
        {:else}
          <span aria-current="page">{seg.label}</span>
        {/if}
        {#if i < segments.length - 1}
          <span class="sep">/</span>
        {/if}
      </li>
    {/each}
  </ol>
</nav>
