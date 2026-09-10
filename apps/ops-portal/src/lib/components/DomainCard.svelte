<style>
  .domain-card {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-sm);
  }

  .domain-card:hover {
    text-decoration: none;
  }

  .domain-header {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
  }

  .domain-icon {
    font-size: 1.5rem;
    line-height: 1;
  }

  .domain-header h3 {
    font-size: var(--font-size-base);
    font-weight: 600;
  }

  .domain-desc {
    flex: 1;
  }

  .domain-counts {
    display: flex;
    gap: var(--spacing-xs);
    flex-wrap: wrap;
  }
</style>

<script>
  import { resolve } from '$app/paths';
  import Badge from './Badge.svelte';

  /** @type {{
   *   id: string,
   *   label: string,
   *   description: string,
   *   iconHint?: string,
   *   repoCount: number,
   *   skillCount: number
   * }}
   */
  let { id, label, description, iconHint = '', repoCount = 0, skillCount = 0 } = $props();

  const icons = {
    'shopping-bag': '🛍️',
    globe: '🌐',
    'shopping-cart': '🛒',
    search: '🔍',
    database: '🗄️',
    edit: '✍️',
    code: '⚙️',
    'file-text': '📄',
    'message-circle': '💬',
    settings: '🔧',
    package: '📦',
    'help-circle': '❓',
    flag: '🏳️'
  };

  const icon = $derived(icons[iconHint] || '📁');
</script>

<a href={resolve(`/domains/${id}`)} class="domain-card card">
  <div class="domain-header">
    <span class="domain-icon">{icon}</span>
    <h3>{label}</h3>
  </div>
  <p class="text-sm text-muted domain-desc">{description}</p>
  <div class="domain-counts">
    <Badge variant={repoCount > 0 ? 'default' : 'default'}>
      {repoCount}
      {repoCount === 1 ? 'repo' : 'repos'}
    </Badge>
    <Badge variant={skillCount > 0 ? 'installed' : 'default'}>
      {skillCount}
      {skillCount === 1 ? 'skill' : 'skills'}
    </Badge>
  </div>
</a>
