<style>
  .footer {
    border-top: 1px solid var(--color-border);
    padding: var(--spacing-lg) 0;
    margin-top: var(--spacing-2xl);
    background: var(--color-surface);
  }

  .footer p + p {
    margin-top: var(--spacing-xs);
  }
</style>

<script>
  import { meta } from '$lib/utils/data.js';
</script>

<footer class="footer">
  <div class="container">
    <p class="text-sm text-muted">
      Data source: <code>{meta.seedDeliverable}/{meta.seedFile}</code>. Generated {meta.generatedAt
        ? new Date(meta.generatedAt).toISOString().split('T')[0]
        : '—'}. Last updated via git commit to <code>src/data/</code>.
    </p>
    <p class="text-sm text-muted">
      Portal v{meta.portalVersion} &middot; {meta.dedupeSummary.totalRepos} repos &middot; {meta
        .dedupeSummary.totalSkills} skills &middot; {meta.dedupeSummary.totalDomains} domains
    </p>
  </div>
</footer>
