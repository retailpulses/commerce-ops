<style>
  .operator-section {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--spacing-lg);
  }

  .operator-title {
    font-size: var(--font-size-xl);
  }

  .operator-actions {
    flex-shrink: 0;
  }

  @media (max-width: 640px) {
    .operator-section {
      flex-direction: column;
      align-items: flex-start;
    }
  }
</style>

<script>
  import { resolve } from '$app/paths';
  import { repos, skills, domains, meta, urls } from '$lib/utils/data.js';
  import DomainCard from '$lib/components/DomainCard.svelte';

  const totalRepos = repos.length;
  const totalSkills = skills.length;
  const totalDomains = domains.length;
  const totalUrls = urls.length;
  const installedSkills = skills.filter((skill) => skill.installed).length;
  const installedPercent = Math.round((installedSkills / totalSkills) * 100);

  const topDomains = domains.slice(0, 6).map((domain) => ({
    ...domain,
    repoCount: domain.repoIds.length,
    skillCount: domain.skillIds.length
  }));
</script>

<svelte:head>
  <title>Registry — Ops Portal</title>
</svelte:head>

<h1>Agent Capability Registry</h1>
<p class="text-muted mt-sm mb-lg">
  Retailpulses internal tool entry point &middot; {meta.dedupeSummary.totalRepos} repos &middot; {meta
    .dedupeSummary.totalSkills} skills &middot; {meta.dedupeSummary.totalDomains} domains
</p>

<div class="stat-grid mb-lg">
  <div class="stat-card">
    <div class="stat-value">{totalRepos}</div>
    <div class="stat-label">Active Repos</div>
  </div>
  <div class="stat-card">
    <div class="stat-value">{totalSkills}</div>
    <div class="stat-label">Total Skills</div>
  </div>
  <div class="stat-card">
    <div class="stat-value">{installedPercent}%</div>
    <div class="stat-label">
      Installed
      <span class="text-sm">({installedSkills}/{totalSkills})</span>
    </div>
  </div>
  <div class="stat-card">
    <div class="stat-value">{totalDomains}</div>
    <div class="stat-label">Capability Domains</div>
  </div>
  <div class="stat-card">
    <div class="stat-value">{totalUrls}</div>
    <div class="stat-label">Frontend URLs</div>
  </div>
</div>

<section class="card mb-lg operator-section">
  <div>
    <h2 class="operator-title">Operator URL Collection</h2>
    <p class="text-muted text-sm mt-sm">
      Keep internal frontend entry points in one place. Operators can add manual URLs in the browser
      without waiting on a backend change.
    </p>
  </div>
  <div class="operator-actions">
    <a href={resolve('/urls')} class="btn btn-primary">Open URL Collection</a>
  </div>
</section>

<h2 class="mb-md">Capability Areas</h2>
<div class="card-grid">
  {#each topDomains as domain (domain.id)}
    <DomainCard {...domain} />
  {/each}
</div>

{#if domains.length > 6}
  <div class="mt-lg">
    <a href={resolve('/domains')} class="btn">View all {domains.length} domains</a>
  </div>
{/if}
