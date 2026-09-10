<style>
  .badge {
    display: inline-flex;
    align-items: center;
    font-size: var(--font-size-xs);
    font-weight: 500;
    padding: 2px 8px;
    border-radius: 999px;
    white-space: nowrap;
    border: 1px solid var(--color-border);
    background: var(--color-bg);
    color: var(--color-text-muted);
  }

  .badge-installed {
    background: var(--color-installed-bg);
    color: var(--color-installed);
    border-color: var(--color-installed);
  }

  .badge-workspace {
    background: var(--color-workspace-bg);
    color: var(--color-workspace);
    border-color: var(--color-workspace);
  }

  .badge-account {
    background: #ede9fe;
    color: var(--color-level-account);
    border-color: var(--color-level-account);
  }

  .badge-agent {
    background: #cffafe;
    color: var(--color-level-agent);
    border-color: var(--color-level-agent);
  }

  .badge-language {
    background: var(--color-primary-light);
    color: var(--color-primary);
    border-color: var(--color-primary);
  }
</style>

<script>
  /** @type {{ variant?: 'default'|'installed'|'workspace'|'account'|'agent'|'language', [key: string]: any }} */
  let { variant = 'default', children, ...rest } = $props();
</script>

<span class="badge badge-{variant}" {...rest}>
  {#if children}
    {@render children()}
  {/if}
</span>
