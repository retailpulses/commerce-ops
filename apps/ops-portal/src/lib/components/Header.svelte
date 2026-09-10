<style>
  .header {
    position: sticky;
    top: 0;
    z-index: 100;
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    height: var(--header-height);
  }

  .header-inner {
    display: flex;
    align-items: center;
    height: 100%;
    gap: var(--spacing-lg);
  }

  .logo {
    font-weight: 700;
    font-size: var(--font-size-lg);
    color: var(--color-text);
    white-space: nowrap;
  }

  .logo:hover {
    text-decoration: none;
    color: var(--color-primary);
  }

  .header-search {
    flex: 1;
    max-width: 400px;
  }

  .desktop-nav {
    display: flex;
    align-items: center;
    gap: var(--spacing-xs);
  }

  .nav-link {
    padding: var(--spacing-xs) var(--spacing-sm);
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    font-weight: 500;
    color: var(--color-text-muted);
    transition:
      color 0.15s,
      background 0.15s;
  }

  .nav-link:hover {
    color: var(--color-text);
    background: var(--color-bg);
    text-decoration: none;
  }

  .hamburger {
    display: none;
    flex-direction: column;
    gap: 4px;
    background: none;
    border: none;
    padding: var(--spacing-sm);
  }

  .hamburger span {
    display: block;
    width: 20px;
    height: 2px;
    background: var(--color-text);
    border-radius: 2px;
  }

  .mobile-menu {
    position: fixed;
    top: var(--header-height);
    left: 0;
    right: 0;
    bottom: 0;
    background: var(--color-surface);
    padding: var(--spacing-lg);
    display: flex;
    flex-direction: column;
    gap: var(--spacing-md);
    border-top: 1px solid var(--color-border);
    z-index: 99;
  }

  .mobile-search {
    margin-bottom: var(--spacing-md);
  }

  .mobile-link {
    display: block;
    padding: var(--spacing-md);
    font-size: var(--font-size-lg);
    font-weight: 500;
    border-radius: var(--radius-md);
    color: var(--color-text);
  }

  .mobile-link:hover {
    background: var(--color-bg);
    text-decoration: none;
  }

  @media (max-width: 768px) {
    .desktop-nav {
      display: none;
    }

    .header-search {
      display: none;
    }

    .hamburger {
      display: flex;
    }
  }
</style>

<script>
  import { resolve } from '$app/paths';
  import SearchBar from './SearchBar.svelte';

  let mobileOpen = $state(false);

  const navLinks = [
    { href: '/', label: 'Metrics' },
    { href: '/tools', label: 'Tools' },
    { href: '/registry', label: 'Registry' },
    { href: '/urls', label: 'URLs' },
    { href: '/repos', label: 'Repos' },
    { href: '/skills', label: 'Skills' },
    { href: '/domains', label: 'Domains' },
    { href: '/ask', label: 'Ask' },
    { href: '/about', label: 'About' }
  ];
</script>

<header class="header">
  <div class="header-inner container">
    <a href={resolve('/')} class="logo">Ops Portal</a>

    <div class="header-search">
      <SearchBar />
    </div>

    <nav class="desktop-nav" aria-label="Main navigation">
      {#each navLinks as link (link.href)}
        <a href={resolve(link.href)} class="nav-link">{link.label}</a>
      {/each}
    </nav>

    <button
      class="hamburger"
      onclick={() => (mobileOpen = !mobileOpen)}
      aria-label="Toggle menu"
      aria-expanded={mobileOpen}
    >
      <span></span>
      <span></span>
      <span></span>
    </button>
  </div>

  {#if mobileOpen}
    <div class="mobile-menu" role="navigation" aria-label="Mobile navigation">
      <div class="mobile-search">
        <SearchBar />
      </div>
      {#each navLinks as link (link.href)}
        <a href={resolve(link.href)} class="mobile-link" onclick={() => (mobileOpen = false)}
          >{link.label}</a
        >
      {/each}
    </div>
  {/if}
</header>
