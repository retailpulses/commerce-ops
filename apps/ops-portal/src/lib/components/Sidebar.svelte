<style>
  .sidebar {
    width: var(--sidebar-width);
    padding: var(--spacing-lg) 0;
    position: sticky;
    top: calc(var(--header-height) + var(--spacing-lg));
    align-self: start;
    max-height: calc(100vh - var(--header-height) - var(--spacing-2xl));
    overflow-y: auto;
  }

  .sidebar-section + .sidebar-section {
    margin-top: var(--spacing-lg);
  }

  .sidebar-title {
    font-size: var(--font-size-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
    padding: 0 var(--spacing-md);
    margin-bottom: var(--spacing-sm);
  }

  .domain-link {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--spacing-xs) var(--spacing-md);
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    color: var(--color-text);
    transition: background 0.15s;
  }

  .domain-link:hover {
    background: var(--color-border-light);
    text-decoration: none;
  }

  .domain-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .domain-count {
    font-size: var(--font-size-xs);
    color: var(--color-text-muted);
    background: var(--color-bg);
    border-radius: 999px;
    padding: 1px 6px;
    min-width: 18px;
    text-align: center;
    flex-shrink: 0;
  }

  @media (max-width: 768px) {
    .sidebar {
      display: none;
    }
  }
</style>

<script>
  import { resolve } from '$app/paths';
  import { domains } from '$lib/utils/data.js';
</script>

<aside class="sidebar">
  <div class="sidebar-section">
    <h3 class="sidebar-title">Collections</h3>
    <nav aria-label="Collection navigation">
      <a href={resolve('/urls')} class="domain-link">
        <span class="domain-label">Frontend URLs</span>
        <span class="domain-count">+</span>
      </a>
    </nav>
  </div>

  <div class="sidebar-section">
    <h3 class="sidebar-title">Capability Domains</h3>
    <nav aria-label="Domain navigation">
      {#each domains as domain (domain.id)}
        <a href={resolve(`/domains/${domain.id}`)} class="domain-link">
          <span class="domain-label">{domain.label}</span>
          <span class="domain-count">{domain.skillIds.length}</span>
        </a>
      {/each}
    </nav>
  </div>
</aside>
