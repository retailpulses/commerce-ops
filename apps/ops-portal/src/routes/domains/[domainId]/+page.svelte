<style>
  .detail-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--spacing-md);
    margin-top: var(--spacing-md);
  }

  .detail-section {
    margin-top: var(--spacing-xl);
  }

  .detail-section h2 {
    font-size: var(--font-size-lg);
    margin-bottom: var(--spacing-sm);
  }
</style>

<script>
  import { resolve } from '$app/paths';
  import { page } from '$app/stores';
  import { domains, getReposByIds, getSkillsByIds } from '$lib/utils/data.js';
  import Breadcrumb from '$lib/components/Breadcrumb.svelte';
  import RepoCard from '$lib/components/RepoCard.svelte';
  import SkillCard from '$lib/components/SkillCard.svelte';
  import TagList from '$lib/components/TagList.svelte';

  const domain = $derived(domains.find((d) => d.id === $page.params.domainId));
  const linkedRepos = $derived(domain ? getReposByIds(domain.repoIds) : []);
  const linkedSkills = $derived(domain ? getSkillsByIds(domain.skillIds) : []);
  const relatedDomains = $derived(
    domain
      ? (domain.relatedDomainIds || []).map((dId) => {
          const d = domains.find((d) => d.id === dId);
          return d ? { id: d.id, label: d.label } : { id: dId, label: dId };
        })
      : []
  );

  let copied = $state(false);
  function copyLink() {
    navigator.clipboard.writeText(window.location.href);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }
</script>

<svelte:head>
  <title>{domain ? domain.label : 'Not Found'} — Ops Portal</title>
</svelte:head>

{#if !domain}
  <h1>Domain not found</h1>
  <p class="text-muted">No domain matches <code>{$page.params.domainId}</code>.</p>
  <a href={resolve('/domains')} class="btn mt-md">Back to domains</a>
{:else}
  <Breadcrumb segments={[{ label: 'Domains', href: '/domains' }, { label: domain.label }]} />

  <div class="detail-header">
    <h1>{domain.label}</h1>
    <button class="btn btn-sm" onclick={copyLink}>
      {copied ? 'Copied!' : 'Copy link'}
    </button>
  </div>

  <p class="text-muted mt-sm">{domain.description}</p>

  {#if linkedRepos.length > 0}
    <div class="detail-section">
      <h2>Repos ({linkedRepos.length})</h2>
      <div class="card-grid">
        {#each linkedRepos as repo (repo.id)}
          <RepoCard {...repo} />
        {/each}
      </div>
    </div>
  {/if}

  {#if linkedSkills.length > 0}
    <div class="detail-section">
      <h2>Skills ({linkedSkills.length})</h2>
      <div class="card-grid">
        {#each linkedSkills as skill (skill.id)}
          <SkillCard {...skill} />
        {/each}
      </div>
    </div>
  {/if}

  {#if relatedDomains.length > 0}
    <div class="detail-section">
      <h2>Related Domains</h2>
      <TagList tags={relatedDomains} baseHref="/domains/" />
    </div>
  {/if}
{/if}
