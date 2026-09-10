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

  .invoke-box {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    padding: var(--spacing-sm) var(--spacing-md);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
  }

  .invoke-box code {
    flex: 1;
    font-size: var(--font-size-sm);
    word-break: break-all;
  }
</style>

<script>
  import { resolve } from '$app/paths';
  import { page } from '$app/stores';
  import { getSkill, domains } from '$lib/utils/data.js';
  import Breadcrumb from '$lib/components/Breadcrumb.svelte';
  import Badge from '$lib/components/Badge.svelte';
  import TagList from '$lib/components/TagList.svelte';

  const skill = $derived(getSkill($page.params.skillId));
  const skillDomains = $derived(
    skill
      ? skill.capabilityDomains.map((dId) => {
          const d = domains.find((d) => d.id === dId);
          return { id: dId, label: d ? d.label : dId };
        })
      : []
  );

  let copied = $state(false);
  function copyLink() {
    navigator.clipboard.writeText(window.location.href);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }

  let installCopied = $state(false);
  function copyInstall() {
    const cmd = `./agents/run-${skill.level === 'agent' ? 'claude-code' : 'opencode'}.sh "${skill.name}"`;
    navigator.clipboard.writeText(cmd);
    installCopied = true;
    setTimeout(() => (installCopied = false), 2000);
  }
</script>

<svelte:head>
  <title>{skill ? skill.name : 'Not Found'} — Ops Portal</title>
</svelte:head>

{#if !skill}
  <h1>Skill not found</h1>
  <p class="text-muted">No skill matches <code>{$page.params.skillId}</code>.</p>
  <a href={resolve('/skills')} class="btn mt-md">Back to skills</a>
{:else}
  <Breadcrumb segments={[{ label: 'Skills', href: '/skills' }, { label: skill.name }]} />

  <div class="detail-header">
    <h1>{skill.name}</h1>
    <button class="btn btn-sm" onclick={copyLink}>
      {copied ? 'Copied!' : 'Copy link'}
    </button>
  </div>

  <p class="text-muted mt-sm">{skill.description}</p>

  <div class="detail-meta mt-md">
    <Badge variant={skill.level}>{skill.level}</Badge>
    <Badge variant={skill.installed ? 'installed' : 'workspace'}>
      {skill.installed ? 'Installed' : 'Workspace only'}
    </Badge>
    <Badge variant="default">{skill.sourceType}</Badge>
  </div>

  <div class="detail-section">
    <h2>Source</h2>
    <dl class="detail-list">
      <div>
        <dt>Source path</dt>
        <dd><code>{skill.sourcePath}</code></dd>
      </div>
      {#if skill.workspacePaths.length > 0}
        <div>
          <dt>Workspace paths</dt>
          <dd>
            {#each skill.workspacePaths as wp (wp)}
              <div><code>{wp}</code></div>
            {/each}
          </dd>
        </div>
      {/if}
    </dl>
  </div>

  <div class="detail-section">
    <h2>Capability Domains</h2>
    <TagList tags={skillDomains} baseHref="/domains/" />
  </div>

  <div class="detail-section">
    <h2>Invoke</h2>
    <p class="text-sm text-muted mb-sm">Copy the run command for this skill:</p>
    <div class="invoke-box">
      <code
        >./agents/run-{skill.level === 'agent' ? 'claude-code' : 'opencode'}.sh "{skill.name}"</code
      >
      <button class="btn btn-sm" onclick={copyInstall}>
        {installCopied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  </div>
{/if}
