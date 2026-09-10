<style>
  .detail-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--spacing-md);
    margin-top: var(--spacing-md);
  }

  .detail-meta {
    display: flex;
    gap: var(--spacing-xs);
    flex-wrap: wrap;
  }

  .detail-section {
    margin-top: var(--spacing-xl);
  }

  .detail-section h2 {
    font-size: var(--font-size-lg);
    margin-bottom: var(--spacing-sm);
  }

  .detail-list {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-sm);
  }

  .detail-list dt {
    font-size: var(--font-size-sm);
    color: var(--color-text-muted);
    font-weight: 500;
  }

  .detail-list dd {
    font-size: var(--font-size-sm);
    word-break: break-all;
  }
</style>

<script>
  import { resolve } from '$app/paths';
  import { page } from '$app/stores';
  import { getRepo, skills, domains } from '$lib/utils/data.js';
  import Breadcrumb from '$lib/components/Breadcrumb.svelte';
  import Badge from '$lib/components/Badge.svelte';
  import TagList from '$lib/components/TagList.svelte';
  import SkillCard from '$lib/components/SkillCard.svelte';

  const repo = $derived(getRepo($page.params.repoId));
  const repoDomains = $derived(
    repo
      ? repo.capabilityDomains.map((dId) => {
          const d = domains.find((d) => d.id === dId);
          return { id: dId, label: d ? d.label : dId };
        })
      : []
  );
  const linkedSkills = $derived(
    repo
      ? skills.filter((s) => s.capabilityDomains.some((d) => repo.capabilityDomains.includes(d)))
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
  <title>{repo ? repo.name : 'Not Found'} — Ops Portal</title>
</svelte:head>

{#if !repo}
  <h1>Repo not found</h1>
  <p class="text-muted">No repo matches <code>{$page.params.repoId}</code>.</p>
  <a href={resolve('/repos')} class="btn mt-md">Back to repos</a>
{:else}
  <Breadcrumb segments={[{ label: 'Repos', href: '/repos' }, { label: repo.name }]} />

  <div class="detail-header">
    <h1>{repo.name}</h1>
    <button class="btn btn-sm" onclick={copyLink}>
      {copied ? 'Copied!' : 'Copy link'}
    </button>
  </div>

  <p class="text-muted mt-sm">{repo.description}</p>

  <div class="detail-meta mt-md">
    {#if repo.primaryLanguage}
      <Badge variant="language">{repo.primaryLanguage}</Badge>
    {/if}
    <Badge>{repo.visibility}</Badge>
    {#if repo.isFork}
      <Badge>Fork</Badge>
    {/if}
    {#if repo.defaultBranch}
      <Badge>branch: {repo.defaultBranch}</Badge>
    {/if}
  </div>

  <div class="detail-section">
    <h2>Details</h2>
    <dl class="detail-list">
      <div>
        <dt>URL</dt>
        <dd>
          <!-- External repository URL; SvelteKit resolve only accepts internal paths. -->
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
          <a href={repo.url} target="_blank" rel="noopener" data-sveltekit-reload>{repo.url}</a>
        </dd>
      </div>
      <div>
        <dt>Local path</dt>
        <dd>{repo.localClonePath || '—'}</dd>
      </div>
    </dl>
  </div>

  <div class="detail-section">
    <h2>Capability Domains</h2>
    <TagList tags={repoDomains} baseHref="/domains/" />
  </div>

  {#if linkedSkills.length > 0}
    <div class="detail-section">
      <h2>Related Skills ({linkedSkills.length})</h2>
      <div class="card-grid">
        {#each linkedSkills as skill (skill.id)}
          <SkillCard {...skill} />
        {/each}
      </div>
    </div>
  {/if}
{/if}
