<style>
  .repo-card {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-sm);
  }

  .repo-card:hover {
    text-decoration: none;
  }

  .repo-top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--spacing-sm);
  }

  .repo-top h3 {
    font-size: var(--font-size-base);
    font-weight: 600;
    word-break: break-all;
  }

  .repo-meta {
    display: flex;
    gap: var(--spacing-xs);
    flex-shrink: 0;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
</style>

<script>
  import { resolve } from '$app/paths';
  import Badge from './Badge.svelte';
  import TagList from './TagList.svelte';
  import { domains } from '$lib/utils/data.js';

  /** @type {{
   *   id: string,
   *   name: string,
   *   description: string,
   *   primaryLanguage: string,
   *   capabilityDomains: string[],
   *   visibility: string
   * }}
   */
  let { id, name, description, primaryLanguage, capabilityDomains = [], visibility } = $props();

  const domainLabels = $derived(
    capabilityDomains.map((dId) => {
      const d = domains.find((d) => d.id === dId);
      return { id: dId, label: d ? d.label : dId };
    })
  );
</script>

<a href={resolve(`/repos/${id}`)} class="repo-card card">
  <div class="repo-top">
    <h3>{name}</h3>
    <div class="repo-meta">
      {#if primaryLanguage}
        <Badge variant="language">{primaryLanguage}</Badge>
      {/if}
      <Badge>{visibility}</Badge>
    </div>
  </div>
  <p class="text-sm text-muted">{description}</p>
  {#if domainLabels.length > 0}
    <TagList tags={domainLabels} baseHref="/domains/" />
  {/if}
</a>
