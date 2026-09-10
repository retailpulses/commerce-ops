<style>
  .skill-card {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-sm);
  }

  .skill-card:hover {
    text-decoration: none;
  }

  .skill-top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--spacing-sm);
  }

  .skill-top h3 {
    font-size: var(--font-size-base);
    font-weight: 600;
    word-break: break-all;
  }

  .skill-meta {
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
   *   level: string,
   *   installed: boolean,
   *   capabilityDomains: string[]
   * }}
   */
  let { id, name, description, level, installed, capabilityDomains = [] } = $props();

  const domainLabels = $derived(
    capabilityDomains.map((dId) => {
      const d = domains.find((d) => d.id === dId);
      return { id: dId, label: d ? d.label : dId };
    })
  );
</script>

<a href={resolve(`/skills/${id}`)} class="skill-card card">
  <div class="skill-top">
    <h3>{name}</h3>
    <div class="skill-meta">
      <Badge variant={level}>{level}</Badge>
      <Badge variant={installed ? 'installed' : 'workspace'}>
        {installed ? 'Installed' : 'Workspace'}
      </Badge>
    </div>
  </div>
  <p class="text-sm text-muted">{description}</p>
  {#if domainLabels.length > 0}
    <TagList tags={domainLabels} baseHref="/domains/" />
  {/if}
</a>
