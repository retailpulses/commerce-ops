<style>
  .tag-list {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-xs);
  }

  .tag-link:hover {
    text-decoration: none;
  }

  .tag-link:hover :global(.badge) {
    filter: brightness(0.95);
  }
</style>

<script>
  import { resolve } from '$app/paths';
  import Badge from './Badge.svelte';

  /** @type {{ tags: { id: string, label: string }[], baseHref?: string }} */
  let { tags = [], baseHref = '' } = $props();
</script>

<div class="tag-list">
  {#each tags as tag (tag.id)}
    {#if baseHref}
      <a href={resolve(`${baseHref}${tag.id}`)} class="tag-link">
        <Badge>{tag.label}</Badge>
      </a>
    {:else}
      <Badge>{tag.label}</Badge>
    {/if}
  {/each}
</div>
