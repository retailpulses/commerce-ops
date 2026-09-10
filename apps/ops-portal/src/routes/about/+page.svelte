<style>
  .about-section {
    margin-top: var(--spacing-xl);
  }

  .about-section h2 {
    font-size: var(--font-size-lg);
    margin-bottom: var(--spacing-sm);
  }

  .about-section ul,
  .about-section ol {
    padding-left: var(--spacing-lg);
  }

  .about-section li {
    margin-bottom: var(--spacing-xs);
    font-size: var(--font-size-sm);
  }

  .summary-table {
    width: 100%;
    max-width: 400px;
    border-collapse: collapse;
  }

  .summary-table td {
    padding: var(--spacing-xs) var(--spacing-sm);
    border-bottom: 1px solid var(--color-border);
    font-size: var(--font-size-sm);
  }

  .summary-table td:first-child {
    font-weight: 500;
  }

  .summary-table td:last-child {
    text-align: right;
  }
</style>

<script>
  import { meta } from '$lib/utils/data.js';
</script>

<svelte:head>
  <title>About — Ops Portal</title>
</svelte:head>

<h1>About</h1>

<section class="about-section">
  <h2>What This Is</h2>
  <p>
    The <strong>Ops Portal</strong> is the Agent Capability Registry and internal tool entry point for
    Retailpulses. It catalogs all active repos, agent skills, and capability domains in a single browsable
    interface.
  </p>
</section>

<section class="about-section">
  <h2>Data Source & Provenance</h2>
  <p>This portal is built from the seed deliverable:</p>
  <ul>
    <li><strong>Deliverable:</strong> <code>{meta.seedDeliverable}</code></li>
    <li><strong>Seed file:</strong> <code>{meta.seedFile}</code></li>
    <li><strong>Generated:</strong> {meta.generatedAt}</li>
    <li><strong>Last manual update:</strong> {meta.lastManualUpdate}</li>
    <li><strong>Portal version:</strong> {meta.portalVersion}</li>
  </ul>
</section>

<section class="about-section">
  <h2>Source Precedence</h2>
  <p>Skills are deduplicated using the following priority (1 = highest):</p>
  <ol>
    <li>
      <code>local_codex</code> — <code>/Users/user/.codex/skills/&lt;skill&gt;/</code> (installed runtime
      instance)
    </li>
    <li>
      <code>workspace_primary</code> —
      <code>retailpulses-agent-skills/skills/&#123;account,agent&#125;/&lt;skill&gt;/</code>
    </li>
    <li>
      <code>workspace_mirror</code> —
      <code
        >agent-core/repos/retailpulses-agent-skills/skills/&#123;account,agent&#125;/&lt;skill&gt;/</code
      >
    </li>
  </ol>
</section>

<section class="about-section">
  <h2>Summary</h2>
  <table class="summary-table">
    <tbody>
      <tr><td>Active repos</td><td>{meta.dedupeSummary.totalRepos}</td></tr>
      <tr><td>Deduplicated skills</td><td>{meta.dedupeSummary.totalSkills}</td></tr>
      <tr><td>Capability domains</td><td>{meta.dedupeSummary.totalDomains}</td></tr>
      <tr><td>Installed locally</td><td>{meta.dedupeSummary.installedSkills}</td></tr>
      <tr><td>Workspace only</td><td>{meta.dedupeSummary.workspaceOnlySkills}</td></tr>
    </tbody>
  </table>
</section>

<section class="about-section">
  <h2>How to Update Data</h2>
  <ol>
    <li>
      Edit the relevant JSON file in <code>src/data/</code> (<code>repos.json</code>,
      <code>skills.json</code>, <code>domains.json</code>, or <code>meta.json</code>).
    </li>
    <li>Run <code>npm run build</code> to verify the changes compile.</li>
    <li>Commit and push to <code>main</code>. Cloudflare Pages auto-deploys.</li>
  </ol>
  <p class="text-sm text-muted mt-sm">
    For bulk updates, regenerate the seed at
    <code>Deliverables/2026-06-12_ops_portal_inventory_plan/repo-skill-seed.json</code>
    and port changes to <code>src/data/</code>.
  </p>
</section>
